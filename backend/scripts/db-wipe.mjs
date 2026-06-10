#!/usr/bin/env node
// Wipe all items from the chatrock DynamoDB table.
// Usage: npm run db:wipe [-- --table chatrock-prod --region ap-southeast-2]

import { DynamoDBClient } from '@aws-sdk/client-dynamodb'
import { DynamoDBDocumentClient, ScanCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb'
import { createInterface } from 'readline'

const args = process.argv.slice(2)
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : undefined }

const TABLE  = get('--table')  ?? 'chatrock-prod'
const REGION = get('--region') ?? 'ap-southeast-2'

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }))

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const confirm = (q) => new Promise(resolve => rl.question(q, resolve))

  console.log(`WARNING: This will delete ALL items from '${TABLE}' in ${REGION}.`)
  const answer = await confirm('Type the table name to confirm: ')
  rl.close()

  if (answer.trim() !== TABLE) {
    console.log('Aborted.')
    process.exit(0)
  }

  let deleted = 0
  let lastKey

  do {
    const { Items: items = [], LastEvaluatedKey } = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: 'PK, SK',
      ExclusiveStartKey: lastKey,
    }))

    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25)
      await ddb.send(new BatchWriteCommand({
        RequestItems: {
          [TABLE]: chunk.map(({ PK, SK }) => ({ DeleteRequest: { Key: { PK, SK } } })),
        },
      }))
    }

    deleted += items.length
    if (items.length) process.stdout.write(`\r  ${deleted} items deleted...`)
    lastKey = LastEvaluatedKey
  } while (lastKey)

  console.log(`\nDone. ${deleted} items deleted from '${TABLE}'.`)
}

main()
