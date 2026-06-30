# Security Policy

## Supported Versions

| Version | Supported |
|---|---|
| latest (main) | Yes |
| older releases | No |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately to: **security@basefy.io**

Include:

- A description of the vulnerability
- Steps to reproduce
- Potential impact
- Any suggested mitigations

You will receive a response within 72 hours. We will work with you to understand and address the issue before any public disclosure.

## Disclosure Policy

- We aim to resolve critical vulnerabilities within 7 days
- We coordinate disclosure timing with the reporter
- We credit researchers in the release notes (with permission)

## Scope

In scope:
- Platform API authentication and authorization bypasses
- SQL injection via the query engine
- Cross-project data leakage
- Privilege escalation

Out of scope:
- Vulnerabilities in third-party dependencies (report to the upstream project)
- Issues requiring physical access
- Social engineering attacks
