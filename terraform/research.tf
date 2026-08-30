# Deep Research (Phase 3) — Step Functions Standard workflow orchestrating the
# Recon -> Plan -> [approval] -> Wave(s) -> Assess -> Report pipeline. Why Step Functions
# instead of a self-reinvoking Lambda: docs/adr/0023-deep-research-step-functions-orchestration.md.
#
# The agent logic lives in ordinary Lambdas (backend/src/research/*.ts, currently stubs —
# filled in by later tasks); this file only wires orchestration. Handlers reuse the shared
# `aws_iam_role.lambda` execution role (terraform/iam.tf) — same DynamoDB/Bedrock/S3 access
# as every other backend Lambda, since the researcher handler (#12) will call Bedrock the
# same way ws/sendMessage.ts does.

locals {
  # A researcher runs an 8-round agentic loop with a web search or fetch in most rounds;
  # measured wall-clock is routinely 220-250s, so anything near the old 300s ceiling made
  # Sandbox.Timedout a matter of when, not if. 900s is the Lambda maximum and costs nothing
  # extra — billing is by actual duration, and a researcher that genuinely wedges is now
  # caught by the wave's Catch rather than by the clock.
  research_handlers = {
    recon          = { name = "research-recon", timeout = 60 }
    plan           = { name = "research-plan", timeout = 120 }
    await_approval = { name = "research-awaitApproval", timeout = 15 }
    researcher     = { name = "research-researcher", timeout = 900 }
    assess         = { name = "research-assess", timeout = 120 }
    report         = { name = "research-report", timeout = 300 }
    fail           = { name = "research-fail", timeout = 15 }
  }
}

resource "aws_lambda_function" "research" {
  for_each         = local.research_handlers
  function_name    = "chatrock-${each.value.name}-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/${each.value.name}.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/${each.value.name}.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = each.value.timeout
  # These ran at the 128 MB default and sat pinned at 128/128 MB used, which is both an OOM
  # risk and a hard CPU throttle (Lambda scales vCPU with memory) on handlers whose whole job
  # is a long agentic loop. 1024 MB is roughly one full vCPU; the duration it buys back is
  # very nearly cost-neutral.
  memory_size = 1024
  environment { variables = local.lambda_env_base }
  tags = { Env = var.env }
}

# ── Step Functions state machine ────────────────────────────────────────────

data "aws_iam_policy_document" "sfn_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["states.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "research_sfn" {
  name               = "chatrock-research-sfn-${var.env}"
  assume_role_policy = data.aws_iam_policy_document.sfn_assume.json
  tags               = { Env = var.env }
}

data "aws_iam_policy_document" "research_sfn_policy" {
  statement {
    sid       = "InvokeResearchLambdas"
    actions   = ["lambda:InvokeFunction"]
    resources = [for f in aws_lambda_function.research : f.arn]
  }
}

resource "aws_iam_role_policy" "research_sfn" {
  name   = "chatrock-research-sfn-policy-${var.env}"
  role   = aws_iam_role.research_sfn.id
  policy = data.aws_iam_policy_document.research_sfn_policy.json
}

# Required for Standard workflow CloudWatch logging (logging_configuration below) —
# these actions aren't resource-scoped per AWS's own docs for this feature.
data "aws_iam_policy_document" "research_sfn_logging" {
  statement {
    sid = "SfnLogging"
    actions = [
      "logs:CreateLogDelivery",
      "logs:GetLogDelivery",
      "logs:UpdateLogDelivery",
      "logs:DeleteLogDelivery",
      "logs:ListLogDeliveries",
      "logs:PutResourcePolicy",
      "logs:DescribeResourcePolicies",
      "logs:DescribeLogGroups",
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "research_sfn_logging" {
  name   = "chatrock-research-sfn-logging-policy-${var.env}"
  role   = aws_iam_role.research_sfn.id
  policy = data.aws_iam_policy_document.research_sfn_logging.json
}

resource "aws_cloudwatch_log_group" "research_sfn" {
  name              = "/aws/vendedlogs/states/chatrock-research-${var.env}"
  retention_in_days = 30
  tags              = { Env = var.env }
}

# One researcher Task per sub-question, run inside the Wave Map state. Kept as a locals
# fragment so the outer state machine JSON below stays readable.
locals {
  # Every Task state routes its failures here. A run that dies with its RUN# row still on a
  # non-terminal status is worse than a run that fails loudly: the panel spins forever and
  # getActiveRun() keeps swallowing the chat's next messages as steering notes.
  # See docs/adr/0035-a-failed-research-run-is-a-terminal-state.md.
  research_catch_all = [{
    ErrorEquals = ["States.ALL"]
    ResultPath  = "$.error"
    Next        = "RunFailed"
  }]

  # Transient Lambda-plane errors only. A researcher that timed out is deliberately NOT
  # retried — it already burned its full 900s budget, and a second attempt would spend it
  # again to reach the same place. Those fall through to the Catch below instead.
  research_lambda_retry = [{
    ErrorEquals     = ["Lambda.ServiceException", "Lambda.AWSLambdaException", "Lambda.SdkClientException", "Lambda.TooManyRequestsException"]
    IntervalSeconds = 2
    MaxAttempts     = 2
    BackoffRate     = 2
  }]

  research_wave_iterator = {
    StartAt = "Researcher"
    States = {
      Researcher = {
        Type       = "Task"
        Resource   = aws_lambda_function.research["researcher"].arn
        ResultPath = "$.result"
        Retry      = local.research_lambda_retry
        # One dead researcher must not take the other sub-questions of its wave down with it:
        # a Map iteration failure aborts every sibling and the whole execution. Degrading to a
        # placeholder finding keeps the run alive with an honest gap in it, which assess.ts
        # can then decide to re-research in a later wave.
        Catch = [{
          ErrorEquals = ["States.ALL"]
          ResultPath  = "$.error"
          Next        = "ResearcherFailed"
        }]
        End = true
      }
      # Shaped exactly like a successful iteration's output ({subQuestion, steeringNotes,
      # result:{finding}}) so assess.ts's flatten needs no special case for it.
      ResearcherFailed = {
        Type = "Pass"
        Parameters = {
          "subQuestion.$"   = "$.subQuestion"
          "steeringNotes.$" = "$.steeringNotes"
          result = {
            finding = {
              "subQuestionId.$" = "$.subQuestion.id"
              summary           = "This sub-question could not be researched — the researcher failed or ran out of time. Treat it as an unanswered gap."
              sourceUrls        = []
            }
          }
        }
        End = true
      }
    }
  }

  research_definition = {
    Comment = "Deep Research: Recon -> Plan -> approval -> Wave(s) -> Assess -> Report. See docs/adr/0023."
    StartAt = "Recon"
    States = {
      Recon = {
        Type       = "Task"
        Resource   = aws_lambda_function.research["recon"].arn
        ResultPath = "$.recon"
        Retry      = local.research_lambda_retry
        Catch      = local.research_catch_all
        Next       = "Plan"
      }
      Plan = {
        Type       = "Task"
        Resource   = aws_lambda_function.research["plan"].arn
        ResultPath = "$.plan"
        Retry      = local.research_lambda_retry
        Catch      = local.research_catch_all
        Next       = "AwaitApproval"
      }
      # .waitForTaskToken: the Lambda persists the token and returns immediately; the state
      # only completes when the WS `researchApprove` action (task #11) calls
      # SendTaskSuccess/SendTaskFailure with that token. 24h timeout matches the plan's
      # "Approval gate" design note — a run that's never approved eventually fails cleanly
      # rather than hanging forever.
      AwaitApproval = {
        Type     = "Task"
        Resource = "arn:aws:states:::lambda:invoke.waitForTaskToken"
        Parameters = {
          "FunctionName" = aws_lambda_function.research["await_approval"].arn
          "Payload" = {
            "taskToken.$" = "$$.Task.Token"
            "runId.$"     = "$.runId"
            "chatId.$"    = "$.chatId"
            "sub.$"       = "$.sub"
            "question.$"  = "$.question"
            "plan.$"      = "$.plan"
            "connId.$"    = "$.connId"
          }
        }
        TimeoutSeconds = 86400
        Retry          = local.research_lambda_retry
        Catch          = local.research_catch_all
        Next           = "ApprovalChoice"
      }
      # "Revise" (researchApprove.ts) resolves the same waitForTaskToken with
      # {revise: true, feedback, plan: <prior plan>}, entirely replacing $ like every other
      # no-ResultPath state here. There's no "Reject" — a user who abandons the plan just
      # leaves it hanging (AwaitApproval's 24h TimeoutSeconds above fails the run cleanly on
      # its own; cleanup doesn't need a button click to depend on).
      ApprovalChoice = {
        Type = "Choice"
        Choices = [
          {
            Variable      = "$.revise"
            BooleanEquals = true
            Next          = "Replan"
          }
        ]
        Default = "Wave"
      }
      # Reuses the Plan lambda (plan.ts branches on priorPlan/feedback vs recon — see its
      # header comment) rather than a dedicated handler. ResultPath="$.plan" merges the
      # revised plan back in and preserves chatId/runId/sub/question/connId for the next
      # AwaitApproval visit, which mints a fresh task token.
      Replan = {
        Type     = "Task"
        Resource = aws_lambda_function.research["plan"].arn
        Parameters = {
          "chatId.$"    = "$.chatId"
          "runId.$"     = "$.runId"
          "sub.$"       = "$.sub"
          "connId.$"    = "$.connId"
          "question.$"  = "$.question"
          "priorPlan.$" = "$.plan"
          "feedback.$"  = "$.feedback"
        }
        ResultPath = "$.plan"
        Retry      = local.research_lambda_retry
        Catch      = local.research_catch_all
        Next       = "AwaitApproval"
      }
      # ItemsPath points at $.nextSubQuestions, not $.plan.subQuestions — the first wave
      # researches the approved plan's sub-questions (researchApprove.ts seeds
      # nextSubQuestions from plan.subQuestions), but every subsequent wave researches
      # whatever Assess decided still has a gap. Parameters injects run context onto each
      # item since a Map item is otherwise just the bare SubQuestion from ItemsPath.
      # ResultPath="$.waveFindings" (not "$.findings") is deliberate: Wave's raw per-item
      # output is {subQuestion, steeringNotes, result:{finding}} (see CLAUDE.md's "The wave
      # loop"), not a plain Finding[], and writing it under a different key than the
      # accumulated $.findings total lets Assess merge the two instead of one clobbering the
      # other.
      Wave = {
        Type           = "Map"
        ItemsPath      = "$.nextSubQuestions"
        MaxConcurrency = 3
        ResultPath     = "$.waveFindings"
        Parameters = {
          "subQuestion.$"   = "$$.Map.Item.Value"
          "chatId.$"        = "$.chatId"
          "runId.$"         = "$.runId"
          "sub.$"           = "$.sub"
          "steeringNotes.$" = "$.steeringNotes"
          "connId.$"        = "$.connId"
        }
        Iterator = local.research_wave_iterator
        Catch    = local.research_catch_all
        Next     = "Assess"
      }
      # No ResultPath — Assess's Result entirely replaces the state (same pattern as
      # AwaitApproval, see CLAUDE.md's "Plan approval gate"), so assess.ts returns every
      # field the next hop (another Wave, or Report) needs: the merged findings total,
      # gapsNotPursued, cleared steeringNotes, incremented roundsSpent, and
      # nextSubQuestions/done for AssessChoice below.
      Assess = {
        Type     = "Task"
        Resource = aws_lambda_function.research["assess"].arn
        Parameters = {
          "chatId.$"         = "$.chatId"
          "runId.$"          = "$.runId"
          "sub.$"            = "$.sub"
          "question.$"       = "$.question"
          "plan.$"           = "$.plan"
          "findings.$"       = "$.findings"
          "waveFindings.$"   = "$.waveFindings"
          "gapsNotPursued.$" = "$.gapsNotPursued"
          "steeringNotes.$"  = "$.steeringNotes"
          "roundsSpent.$"    = "$.roundsSpent"
          "connId.$"         = "$.connId"
        }
        Retry = local.research_lambda_retry
        Catch = local.research_catch_all
        Next  = "AssessChoice"
      }
      # Backstop against a runaway supervisor: the supervisor decides when it's satisfied
      # (assess.ts's done), but a hard round cap still wins if it never is. See plan's
      # "Ceiling" note.
      AssessChoice = {
        Type = "Choice"
        Choices = [
          {
            Variable      = "$.done"
            BooleanEquals = true
            Next          = "Report"
          },
          {
            Variable                 = "$.roundsSpent"
            NumericGreaterThanEquals = 8
            Next                     = "Report"
          }
        ]
        Default = "Wave"
      }
      Report = {
        Type       = "Task"
        Resource   = aws_lambda_function.research["report"].arn
        ResultPath = "$.report"
        Retry      = local.research_lambda_retry
        Catch      = local.research_catch_all
        End        = true
      }
      # Marks the RUN# row failed and tells the client, then re-fails the execution so the
      # Step Functions console/alarms still see a FAILED run. fail.ts leaves an already-done
      # row alone — Report's own Catch can fire after the report was persisted.
      RunFailed = {
        Type     = "Task"
        Resource = aws_lambda_function.research["fail"].arn
        Parameters = {
          # Only the two ids and the error envelope. connId is read off the RUN# row by
          # fail.ts instead of being passed here: a "$.connId" reference throws
          # States.Runtime — failing the failure handler — for any state whose input never
          # carried one, which is exactly the situation this state exists to survive.
          "chatId.$" = "$.chatId"
          "runId.$"  = "$.runId"
          "error.$"  = "$.error"
        }
        ResultPath = "$.failResult"
        Next       = "RunFailedTerminal"
      }
      RunFailedTerminal = {
        Type  = "Fail"
        Error = "ResearchRunFailed"
        Cause = "A Deep Research state failed; the RUN# row was marked failed by RunFailed."
      }
    }
  }
}

# WS action "startResearch" (backend/src/ws/startResearch.ts) — the only Lambda that needs
# the state machine's ARN, since it's the one that calls StartExecution; every other
# research Lambda above just runs as a Task the state machine invokes.
resource "aws_lambda_function" "ws_start_research" {
  function_name    = "chatrock-ws-startResearch-${var.env}"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/dist/ws-startResearch.zip"
  source_code_hash = filebase64sha256("${path.module}/dist/ws-startResearch.zip")
  handler          = "index.handler"
  runtime          = local.lambda_runtime
  timeout          = 10
  environment {
    variables = merge(local.lambda_env_base, {
      RESEARCH_STATE_MACHINE_ARN = aws_sfn_state_machine.research.arn
    })
  }
  tags = { Env = var.env }
}

resource "aws_lambda_permission" "ws_start_research_apigw" {
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.ws_start_research.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}

resource "aws_sfn_state_machine" "research" {
  name       = "chatrock-research-${var.env}"
  role_arn   = aws_iam_role.research_sfn.arn
  type       = "STANDARD"
  definition = jsonencode(local.research_definition)

  logging_configuration {
    log_destination        = "${aws_cloudwatch_log_group.research_sfn.arn}:*"
    include_execution_data = true
    level                  = "ALL"
  }

  tags = { Env = var.env }
}
