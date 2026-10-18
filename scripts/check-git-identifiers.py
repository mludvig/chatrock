"""Reject local environment identifiers without storing a private denylist in Git."""

import configparser
import os
from pathlib import Path
import re
import sys
from urllib.parse import urlparse


def local_identifiers(root):
    profiles, identifiers = set(), set()
    for name in ("config", "credentials"):
        path = Path.home() / ".aws" / name
        if not path.exists():
            continue
        config = configparser.ConfigParser(interpolation=None)
        try:
            config.read(path)
        except configparser.Error:
            continue
        for section in config.sections():
            if name == "credentials" or section.startswith("profile "):
                profiles.add(section.removeprefix("profile "))
        identifiers.update(re.findall(r"(?<!\d)\d{12}(?!\d)", path.read_text()))
    if os.environ.get("AWS_PROFILE"):
        profiles.add(os.environ["AWS_PROFILE"])
    profiles.discard("default")
    for relative in (".env", "frontend/.deploy-env", "terraform/terraform.tfvars",
                     "terraform/terraform.tfstate"):
        path = root / relative
        if not path.exists():
            continue
        text = path.read_text()
        if relative.endswith("tfstate"):
            identifiers.update(re.findall(r"arn:[^:\s]+:[^:\s]+:[^:\s]*:(\d{12}):", text))
        for line in text.splitlines():
            match = re.match(
                r"\s*(?:export\s+)?(AWS_PROFILE|E2E_BASE_URL|COGNITO_USERNAME|"
                r"VITE_API_BASE_URL|VITE_WS_URL|VITE_APP_URL|VITE_COGNITO_DOMAIN|"
                r"VITE_COGNITO_USER_POOL_ID|VITE_COGNITO_CLIENT_ID|"
                r"domain_name|hosted_zone_name|hosted_zone_id|alarm_email)\s*=\s*(.*)", line,
            )
            if not match:
                continue
            key, value = match.groups()
            value = value.strip().strip("\"'")
            if key == "AWS_PROFILE":
                profiles.add(value)
            elif "://" in value:
                host = urlparse(value).hostname
                if host:
                    identifiers.add(host)
            elif value:
                identifiers.add(value)
    profiles.discard("default")
    return profiles, identifiers


def findings(text, profiles, identifiers):
    result = set()
    for name in profiles:
        if name and re.search(r"(?<![\w-])" + re.escape(name) + r"(?![\w-])", text, re.I):
            result.add("local AWS profile")
    for value in identifiers:
        if value and value in text:
            result.add("local environment identifier")
    return result


def main():
    root = Path(__file__).resolve().parent.parent
    profiles, identifiers = local_identifiers(root)
    failed = False
    for filename in sys.argv[1:]:
        path = Path(filename)
        if not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue
        try:
            text = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
        problems = findings(text, profiles, identifiers)
        if problems:
            print(f"{filename}: {', '.join(sorted(problems))}; use generic placeholders.")
            failed = True
    return int(failed)


if __name__ == "__main__":
    sys.exit(main())
