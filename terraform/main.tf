terraform {
  required_version = ">= 1.14"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
  # Uncomment to enable S3 remote state:
  # backend "s3" {
  #   bucket = "your-tf-state-bucket"
  #   key    = "chatrock/terraform.tfstate"
  #   region = "ap-southeast-2"
  # }
}

# Primary provider — ap-southeast-2 (all app resources)
provider "aws" {
  region = var.aws_region
}

# us-east-1 provider — required for CloudFront ACM cert and WAF WebACL (CLOUDFRONT scope)
provider "aws" {
  alias  = "us_east_1"
  region = "us-east-1"
}

data "aws_caller_identity" "current" {}
