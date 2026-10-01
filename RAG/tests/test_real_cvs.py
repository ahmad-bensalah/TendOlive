"""Reading real CVs: the 19 sample OliveSoft CVs (PDF made with LaTeX) in data/olivesoft_cvs/.

These CVs have sections (Profile, Professional Experience, Skills, Certifications and Awards)
instead of labelled lines, and their PDF text has export problems. No index or model needed.
"""
from datetime import date
from pathlib import Path

import pytest

from rag import cvparse, taxonomy as tx
from rag.loader import clean_pdf_text, load_documents
from rag.profiles import rule_profile
from rag.reqparse import parse

REAL_DIR = Path(__file__).resolve().parents[1] / "data"


@pytest.fixture(scope="module")
def cvs():
    docs = [d for d in load_documents(REAL_DIR) if d.path.startswith("olivesoft_cvs/")]
    if not docs:
        pytest.skip("data/olivesoft_cvs/ is empty")
    return docs


def cv(cvs, number):
    """CV by number: CV_03.pdf or CV_03_Firstname_Lastname.pdf."""
    key = f"CV_{number:02d}"
    found = [d for d in cvs if d.doc_id == f"{key}.pdf" or d.doc_id.startswith(key + "_")]
    assert found, f"{key} not found"
    return found[0]


def test_pdf_text_is_repaired():
    raw = "textbfFacult´ e des Sciences\n\x88Processed ¿15TB with ¡200ms latency, a 3 Öreduction, **12k** users"
    out = clean_pdf_text(raw)
    assert out.startswith("Faculté des Sciences")
    assert ">15TB" in out and "<200ms" in out and "3× reduction" in out and "12k users" in out
    assert "\x88" not in out and "textbf" not in out and "**" not in out
    # LaTeX T1 font codes, a broken \\hfill ("ill") before dates, kerning read as spaces
    out = clean_pdf_text("Data Engineer ill July 2023 \x15 Present\nApache Air\x1dow\nCertifications and A wards\n"
                         "A WS Certified, BI T eam Lead. A web app.")
    assert "Data Engineer July 2023 – Present" in out and "Airflow" in out
    assert "Certifications and Awards" in out and "AWS Certified" in out and "Team Lead" in out
    assert "A web app" in out


def test_sections_are_found():
    text = "Jane Doe\nTunis\nProfile\nData Engineer with 4+ years of experience.\nSkills\nPython\n" \
           "Certifications and Awards\nGoogle Cloud Professional Data Engineer"
    keys = [k for k, _ in cvparse.sections(text)]
    assert keys == ["top", "profile", "skills", "certifications"]
    assert cvparse.person_name(text) == "Jane Doe"
    assert cvparse.headline(text) == "Data Engineer"
    assert cvparse.person_name("A va Thompson\nTunis\nProfile\nx") == "Ava Thompson"
    assert cvparse.heading("Professional Exp erience") == "experience"


def test_years_from_job_dates():
    text = ("Professional Experience\n"
            "Data Engineer Jan 2020 – Dec 2021\n"
            "Data Engineer Jan 2021 – Present\n"        # overlap counted once
            "Data Intern June 2019 – August 2019\n")     # internships do not count
    assert cvparse.years_from_dates(text, today=date(2024, 12, 15)) == 5
    assert cvparse.current_job_title(text) == "Data Engineer"


def test_title_and_summary_of_a_real_cv(cvs):
    d = cv(cvs, 1)
    assert d.title.endswith(" - Cloud Infrastructure Engineer")
    assert d.summary.startswith("Cloud Infrastructure Engineer with over three years")


def test_certifications_come_from_the_certifications_section(cvs):
    p = rule_profile(cv(cvs, 1))
    assert {"CKA", "AWS Solutions Architect"} <= set(p["certifications"])
    # CV 18 talks about ISO 27001 work, but no certificate is listed: not certified.
    assert "ISO 27001" not in rule_profile(cv(cvs, 18))["certifications"]
    # CV 12 lists "Scrum Master" as a skill only; CV 14 holds the certificate.
    assert "Scrum Master (PSM/CSM)" not in rule_profile(cv(cvs, 12))["certifications"]
    assert "Scrum Master (PSM/CSM)" in rule_profile(cv(cvs, 14))["certifications"]
    # One Salesforce certificate per job: CV 04 is the administrator, CV 08 the developer.
    assert "Salesforce Administrator" in rule_profile(cv(cvs, 4))["certifications"]
    assert "Salesforce Administrator" not in rule_profile(cv(cvs, 8))["certifications"]


def test_years_and_seniority(cvs):
    p1 = rule_profile(cv(cvs, 1))          # "over three years" written in words
    assert (p1["years"], p1["years_source"], p1["seniority"]) == (3, "written", "mid")
    p14 = rule_profile(cv(cvs, 14))        # "over 9 years"
    assert p14["years"] == 9 and p14["seniority"] == "senior"
    assert rule_profile(cv(cvs, 16))["seniority"] == "senior"     # Team Lead
    assert rule_profile(cv(cvs, 11))["seniority"] == "junior"     # student / apprentice
    p10 = rule_profile(cv(cvs, 10))        # no years written: counted from the job dates
    assert p10["years_source"] == "job dates" and p10["seniority"] != "senior"


def test_roles_come_from_the_current_job(cvs):
    assert "product owner" in rule_profile(cv(cvs, 12))["roles"]
    assert "business analyst" not in rule_profile(cv(cvs, 12))["roles"]  # was a BA in 2023
    assert "devops" not in rule_profile(cv(cvs, 14))["roles"]            # was DevOps before
    assert "developer" in rule_profile(cv(cvs, 8))["roles"]


def test_implied_skills():
    assert "etl" in tx.expand_skills(["talend"])
    assert "big data" in tx.expand_skills(["databricks"])   # databricks -> spark -> big data


def test_requirement_reading():
    assert parse("Tableau dashboards", "technical").all_skills          # Power BI is not proof of Tableau
    assert not parse("React or Angular frontend", "technical").all_skills
    assert "tableau" not in parse("Tableau de bord analytique", "technical").skills
    pl300 = parse("Power BI Data Analyst certification (PL-300)", "team")
    assert pl300.certs == ["Power BI Data Analyst (PL-300)"] and not pl300.roles
