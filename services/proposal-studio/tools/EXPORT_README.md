# RFP Studio - Export Guide

## 📦 Export Scripts

Deux scripts sont fournis pour exporter le projet de manière propre:

### 1. Export TAR.GZ (Linux/Mac)
```bash
./export_project.sh
```

### 2. Export ZIP (Windows-friendly)
```bash
./export_project_zip.sh
```

## 📊 Tailles

| Version | Taille | Description |
|---------|--------|-------------|
| **Complète** | 391 MB | Avec .venv + templates + caches |
| **Export propre** | ~1 MB | Sans .venv, sans templates, code source uniquement |

## ✅ Contenu de l'export

L'archive exportée contient:

- ✅ **Code source complet**
  - Python (server.py, layout_engine.py, pptx_exporter.py, etc.)
  - JavaScript (agents/lib/*, static/*)
  - HTML/CSS (editor.html, index.html, static/*)
  
- ✅ **Agents & Workflows**
  - workflows/*.json (n8n workflows)
  - agents/lib/*.js (agent logic)
  - agents/prompts/*.md (system prompts)
  - agents/catalog/*.json (pricing data)

- ✅ **Tests & Documentation**
  - tests/* (94 tests unitaires)
  - agents/tests/* (agent tests)
  - docs/* (documentation complète)

- ✅ **Configuration**
  - requirements.txt
  - deck.schema.json
  - start.sh / start.bat
  - .env.example

- ✅ **Dossiers vides (structure)**
  - templates/ (.gitkeep)
  - saves/ (.gitkeep)
  - exports/ (.gitkeep)
  - uploads/ (.gitkeep + mock diagrams)

## ❌ Exclus de l'export

Pour réduire la taille et éviter les données sensibles:

- ❌ **.venv/** (261 MB) - Environnement virtuel Python
- ❌ **__pycache__/** (340 KB) - Cache Python
- ❌ **templates/** (79 MB) - Templates visuels (à installer séparément)
- ❌ **saves/*.json** (6.4 MB) - Decks générés
- ❌ **exports/*** (3.3 MB) - Exports PDF/PPTX
- ❌ **uploads/*** (4.3 MB) - Fichiers uploadés (sauf mock diagrams)
- ❌ **.git/** - Historique Git
- ❌ **node_modules/** - Dépendances Node
- ❌ **agents/registry/** - Registry runtime
- ❌ **.env** - Variables d'environnement

## 🚀 Installation sur nouvelle machine

### Prérequis
- Python 3.8+
- pip
- Git (optionnel)

### Étapes

1. **Extraire l'archive**
   ```bash
   # TAR.GZ
   tar -xzf rfp-studio-export-YYYYMMDD-HHMMSS.tar.gz
   cd rfp-studio-export-YYYYMMDD-HHMMSS
   
   # ZIP
   unzip rfp-studio-export-YYYYMMDD-HHMMSS.zip
   cd rfp-studio-export-YYYYMMDD-HHMMSS
   ```

2. **Créer l'environnement virtuel**
   ```bash
   python3 -m venv .venv
   source .venv/bin/activate  # Linux/Mac
   # OU
   .venv\Scripts\activate     # Windows
   ```

3. **Installer les dépendances**
   ```bash
   pip install -r requirements.txt
   ```

4. **Copier les variables d'environnement**
   ```bash
   cp .env.example .env
   # Éditer .env avec vos valeurs
   ```

5. **Installer les templates** (si nécessaire)
   
   Les templates visuels ne sont pas inclus dans l'export. Pour les installer:
   
   a. Copier vos templates depuis votre machine actuelle:
   ```bash
   # Sur la machine source
   cd /chemin/vers/rfp-studio
   tar -czf templates-export.tar.gz templates/library
   
   # Sur la nouvelle machine
   cd /chemin/vers/rfp-studio-export
   tar -xzf templates-export.tar.gz
   ```
   
   b. Ou importer de nouveaux templates:
   ```bash
   python3 template_importer.py import template.zip
   ```

6. **Démarrer le serveur**
   ```bash
   ./start.sh     # Linux/Mac
   # OU
   start.bat      # Windows
   ```

7. **Vérifier**
   - Ouvrir http://localhost:8091
   - Le serveur doit afficher "RFP Slide Deck Studio"

## 🧪 Tests

Après installation, vérifier que tout fonctionne:

```bash
# Tests plateforme (94 tests)
python3 -m unittest discover tests

# Tests agents
cd agents
npm test  # ou: node --test tests
```

## 📝 Templates

### Structure attendue
```
templates/
├── library/          # Templates installés
│   ├── ID1/
│   │   ├── metadata.json
│   │   └── assets/
│   └── ID2/
│       ├── metadata.json
│       └── assets/
├── inbox/            # Templates en attente
├── trash/            # Templates supprimés
├── README.md
├── settings.json
└── template.schema.json
```

### Importer un template
```bash
python3 template_importer.py import mon-template.zip
```

### Template par défaut
Configuré dans `templates/settings.json`:
```json
{
  "default_template_id": "offre-commerciale-crosstalent-infrastruc"
}
```

## 🔑 Configuration

### Variables d'environnement (.env)
```bash
# API
STUDIO_API_KEY=your_secret_key_here
PORT=8091

# Chemins
SAVES_DIR=saves
EXPORTS_DIR=exports
UPLOADS_DIR=uploads
TEMPLATES_DIR=templates

# Features
ENABLE_UPLOAD=true
MAX_UPLOAD_SIZE=25  # MB
```

## 🐛 Dépannage

### Erreur: templates not found
- Vérifier que le dossier `templates/library` existe
- Importer au moins un template
- Vérifier `templates/settings.json`

### Erreur: module not found
```bash
# Réinstaller les dépendances
pip install -r requirements.txt --force-reinstall
```

### Erreur: port already in use
```bash
# Changer le port dans .env
PORT=8092
```

## 📚 Documentation complète

- [README.md](README.md) - Vue d'ensemble
- [START_HERE.md](START_HERE.md) - Guide de démarrage
- [docs/](docs/) - Documentation complète
- [agents/README.md](agents/README.md) - Documentation agents

## 🔄 Mise à jour

Pour mettre à jour depuis Git:
```bash
git pull origin main
pip install -r requirements.txt --upgrade
```

## 📞 Support

En cas de problème:
1. Vérifier les logs du serveur
2. Lire la documentation dans `docs/`
3. Vérifier les tests passent
4. Consulter `docs/agents/RUNBOOK.md` pour les problèmes agents

---

**Version:** 1.2.0
**Date:** 2024-10-20
