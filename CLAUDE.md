# Shionarium development

- Read `README.md` and `docs/README.md` for installation and public documentation.
- Check Git status before editing; preserve unrelated changes.
- Keep the framework generic; themes and character packs belong in plugins.
- Never commit conversations, private authoring documents, credentials, personal libraries or local evaluation output. Run `python tools/check_public_tree.py` before publishing.
- Prefer temporary databases and synthetic fixtures. Do not start live integrations or make paid requests merely to validate a change.
- Use the configured Python environment and pinned dependencies. Report changes, tests and limitations accurately.
