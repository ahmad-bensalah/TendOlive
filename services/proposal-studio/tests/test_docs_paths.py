"""tests/test_docs_paths.py — Every file path mentioned in the docs must exist.

Scans README.md, START_HERE.md, docs/*.md, tests/inputs/README.md and workflows/README.md
(CHANGELOG.md is history and is excluded) for paths written in backticks or as Markdown
links, and asserts each one exists in the project. Also asserts that the project root holds
no release archives (they belong in ../dist/).
"""
import re
import unittest
from pathlib import Path

STUDIO_DIR = Path(__file__).resolve().parent.parent

DOC_FILES = [
    STUDIO_DIR / "README.md",
    STUDIO_DIR / "START_HERE.md",
    STUDIO_DIR / "tests" / "inputs" / "README.md",
    STUDIO_DIR / "workflows" / "README.md",
    *sorted((STUDIO_DIR / "docs").glob("*.md")),
]

PATH_PREFIXES = ("tests/", "tools/", "docs/", "workflows/", "samples/", "static/")
PATH_SUFFIXES = (".py", ".sh", ".bat", ".json", ".md")
# Created by the server at run time, or outside the project: never checked.
IGNORED_PREFIXES = ("saves/", "uploads/", "exports/", "screenshots/", "dist/", "../", "/", "~")

# Files the agent teammates will CREATE (their deliverables), and the name of the legacy
# save file that Phase 0 migrates away. They are mentioned on purpose and do not exist yet.
EXPECTED_LATER = {
    "workflows/credibility.json", "credibility.json",          # Agent 5 export (teammate 2)
    "workflows/README_credibility.md",                         # Agent 5 import notes (teammate 2)
    "tests/credibility/extra/",                                # extra Agent 5 inputs, if any
    "diagrams.json",                                           # diagram agents export (teammate 1)
    "None.json",                                               # legacy save name, migrated at start
}

RUNTIME_DIRS = {"saves", "uploads", "exports", "screenshots", "__pycache__", ".venv"}

BACKTICK = re.compile(r"`([^`\n]+)`")
MD_LINK = re.compile(r"\]\(([^)\s]+)\)")


def candidate_paths(text):
    for raw in BACKTICK.findall(text) + MD_LINK.findall(text):
        token = raw.strip().split("#")[0].rstrip(".,:;")
        # A command such as `python3 tests/check_inputs.py`: check each word.
        for word in token.split():
            word = word.strip("'\"()")
            if word.startswith("./"):
                word = word[2:]
            if not word or "://" in word or "<" in word or "*" in word or "$" in word or "{" in word:
                continue
            if word.startswith(IGNORED_PREFIXES):
                continue
            if word.startswith(PATH_PREFIXES) or word.endswith(PATH_SUFFIXES):
                yield word


def exists_in_project(rel, doc):
    if (STUDIO_DIR / rel).exists() or (doc.parent / rel).exists():
        return True
    if "/" not in rel:
        # A bare file name (for example `software.json` in a sentence about samples/):
        # accept it if a file with that name exists somewhere in the project.
        return any(not (set(p.relative_to(STUDIO_DIR).parts) & RUNTIME_DIRS)
                   for p in STUDIO_DIR.rglob(rel))
    return False


class TestDocsPaths(unittest.TestCase):
    def test_doc_files_exist(self):
        for doc in DOC_FILES:
            self.assertTrue(doc.exists(), doc)

    def test_every_mentioned_path_exists(self):
        missing = []
        for doc in DOC_FILES:
            text = doc.read_text(encoding="utf-8")
            for rel in sorted(set(candidate_paths(text))):
                # Links are relative to the document; plain mentions are relative to the project root.
                if rel not in EXPECTED_LATER and not exists_in_project(rel, doc):
                    missing.append(f"{doc.relative_to(STUDIO_DIR)}: {rel}")
        self.assertEqual(missing, [], "Docs mention files that do not exist:\n" + "\n".join(missing))

    def test_relative_links_resolve_from_their_document(self):
        broken = []
        for doc in DOC_FILES:
            for link in MD_LINK.findall(doc.read_text(encoding="utf-8")):
                target = link.split("#")[0]
                if not target or "://" in target or target.startswith(("mailto:", "#")):
                    continue
                resolved = (doc.parent / target).resolve()
                if STUDIO_DIR not in resolved.parents and resolved != STUDIO_DIR:
                    broken.append(f"{doc.relative_to(STUDIO_DIR)}: {link} (points outside the project)")
                elif not resolved.exists():
                    broken.append(f"{doc.relative_to(STUDIO_DIR)}: {link}")
        self.assertEqual(broken, [], "Broken Markdown links:\n" + "\n".join(broken))

    def test_no_archives_in_project_root(self):
        archives = [p.name for p in STUDIO_DIR.iterdir()
                    if p.name.endswith((".tar.gz", ".tgz", ".zip"))]
        self.assertEqual(archives, [], "Release archives belong in ../dist/, not in the project root")


if __name__ == "__main__":
    unittest.main()
