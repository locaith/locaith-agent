# Security policy

Locaith AI Agent reads files, runs commands and can control a browser on your computer when you allow it, so we take vulnerability reports seriously.

## Reporting a vulnerability

Please **do not open a public issue** for a security problem. Use either of these two private channels:

- **GitHub:** open the repository's **Security** tab and choose **Report a vulnerability** (private vulnerability reporting). Only you and the maintainers can see the report.
- **Email:** **locaithsolution@locaith.com** with the subject `SECURITY: <short title>`.

Either way, include:

- what you found and the impact you expect;
- the version (the extension, `locaith --version`, or the Chrome / Edge package) and your operating system;
- steps, or a small proof of concept, that reproduce it.

We read every report and reply as soon as we can. Please give us a reasonable time to fix the problem before you publish details; we are happy to credit you in the release notes if you wish.

## Supported versions

Only the latest published version of the VS Code extension, the Chrome / Edge package and `locaith-cli` receives security fixes.

## What is in scope

- The permission system: an action that should ask first but does not, or an approval prompt that hides or misrepresents what will run.
- Path, command and file handling, and anything that lets one project or web page act outside what you approved.
- Secret handling: API keys saved in `~/.locaith`, account tokens, and masking in logs and in the chat.
- The VS Code ⇄ Chrome bridge and the Remote connection.
- Anything that sends your data to a place you did not configure.

Wrong or unsafe output from an AI model (for example a model writing buggy code) is not a security vulnerability in this project; open a normal issue instead.
