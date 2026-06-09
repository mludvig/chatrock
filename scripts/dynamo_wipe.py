#!/usr/bin/env python3
"""
Wipe all items from the chatrock DynamoDB table.

Usage:
  python3 scripts/dynamo_wipe.py [--table chatrock-prod] [--region ap-southeast-2]
"""
import argparse
import boto3
from boto3.dynamodb.conditions import Key


def wipe(table_name: str, region: str) -> None:
    print(f"WARNING: This will delete ALL items from '{table_name}' in {region}.")
    confirm = input("Type the table name to confirm: ").strip()
    if confirm != table_name:
        print("Aborted.")
        return

    dynamodb = boto3.resource("dynamodb", region_name=region)
    table = dynamodb.Table(table_name)

    deleted = 0
    scan_kwargs: dict = {"ProjectionExpression": "PK, SK"}

    while True:
        response = table.scan(**scan_kwargs)
        items = response.get("Items", [])
        if not items:
            break

        with table.batch_writer() as batch:
            for item in items:
                batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})

        deleted += len(items)
        print(f"  {deleted} items deleted...")

        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            break
        scan_kwargs["ExclusiveStartKey"] = last_key

    print(f"Done. {deleted} items deleted from '{table_name}'.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Wipe all items from a DynamoDB table.")
    parser.add_argument("--table", default="chatrock-prod", help="Table name (default: chatrock-prod)")
    parser.add_argument("--region", default="ap-southeast-2", help="AWS region (default: ap-southeast-2)")
    args = parser.parse_args()
    wipe(args.table, args.region)
