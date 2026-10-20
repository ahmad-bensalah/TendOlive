# Templates OliveSoft / OliveSoft templates

**FR** — Déposez un modèle `.pptx` (ou `.pdf`) dans `templates/inbox/`, puis cliquez **Recharger**
dans la section « Modèles » de l'écran d'accueil (ou redémarrez le serveur). Le modèle est importé
**sans aucun texte** : seuls les fonds, formes, images et logos sont conservés ; le contenu écrit
par les agents prend la place des textes supprimés. Vous pouvez aussi utiliser « Ajouter un modèle ».

**EN** — Drop a `.pptx` (or `.pdf`) template in `templates/inbox/`, then click **Recharger** in the
"Modèles" section of the main screen (or restart the server). The template is imported **with no
text at all**: only backgrounds, shapes, pictures and logos are kept; the agents' content takes the
place of the removed texts. "Ajouter un modèle" does the same from the browser.

| Folder / file | What it is |
|---|---|
| `inbox/` | Your original files. Never modified by the platform. Committed. |
| `library/<id>/template.json` | Generated design-only template (theme, decor, text zones). Not committed: rebuilt at start. |
| `library/<id>/assets/` | Pictures and shapes used by the design. |
| `trash/` | Deleted templates (recoverable). |
| `settings.json` | The default template. |
| `template.schema.json` | The format of `template.json`. |

Limits: `.pptx` or `.pdf`, 60 MB, 30 slides. Command line:
`python3 tools/import_template.py "templates/inbox/My template.pptx" [--id my-id] [--content-slide 3]`.
A `<name>.meta.json` next to the file can set `{"name": "...", "contentSlideIndex": 3}`
(0-based index of the slide whose design is used for content slides).
