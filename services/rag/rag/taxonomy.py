"""Shared vocabulary (English + French) used by the profile extractor and the
requirement parser. Each canonical name maps to the ways people write it.

Add a line here when a new skill or certification appears in the documents.
"""
import re
import unicodedata

SKILLS = {
    "react": ["react", "react.js", "reactjs"],
    "angular": ["angular"],
    "vue": ["vue", "vue.js"],
    # Not "node" alone: "a 5-node Swarm", "a multi-node NiFi cluster" are not Node.js.
    "node.js": ["node.js", "nodejs", "node js", "express", "nestjs"],
    "java": ["java"],
    "spring": ["spring", "spring boot", "springboot"],
    "php": ["php"],
    "laravel": ["laravel"],
    "python": ["python"],
    "typescript": ["typescript"],
    "postgresql": ["postgresql", "postgres"],
    "mysql": ["mysql"],
    "mongodb": ["mongodb", "mongo"],
    "oracle": ["oracle"],
    "rest api": ["rest api", "rest apis", "api rest", "restful", "openapi"],
    "aws": ["aws", "amazon web services"],
    "azure": ["azure"],
    "docker": ["docker"],
    "kubernetes": ["kubernetes", "k8s", "aks"],
    "ci/cd": ["ci/cd", "gitlab ci", "continuous integration"],
    "terraform": ["terraform"],
    "flutter": ["flutter"],
    "mobile development": ["mobile app", "mobile apps", "mobile application", "application mobile", "mobile developer", "mobile banking app", "mobile"],
    "react native": ["react native"],
    "power bi": ["power bi", "powerbi"],
    "airflow": ["airflow"],
    "dashboard": ["dashboard", "dashboards", "tableau de bord", "tableaux de bord"],
    "llm": ["llm", "llms", "large language model"],
    "rag": ["rag", "retrieval augmented generation", "retrieval-augmented generation"],
    "machine learning": ["machine learning", "apprentissage automatique", "ml"],
    "artificial intelligence": ["artificial intelligence", "intelligence artificielle", "ia"],
    "ux/ui design": ["ux/ui", "ui/ux", "ux", "figma", "user research"],
    "cypress": ["cypress"],
    "selenium": ["selenium"],
    "cisco": ["cisco"],
    "network": ["network", "networking", "reseau", "reseaux", "switches", "routers", "routeurs"],
    "security software": ["security software", "logiciels de securite", "antivirus", "edr", "endpoint protection"],
    "penetration testing": ["penetration testing", "pentest", "pentesting"],
    "odoo": ["odoo"],
    "erp": ["erp"],
    "training": ["training", "formation", "formations", "trainer", "formateur"],
    # data engineering and BI (added for the sample OliveSoft CVs)
    "sql": ["sql", "t-sql", "tsql", "pl/sql", "sql server"],
    "etl": ["etl", "elt", "etl/elt", "data integration", "integration de donnees"],
    "talend": ["talend"],
    "ssis": ["ssis"],
    "azure data factory": ["azure data factory", "adf"],
    "nifi": ["nifi"],
    "airbyte": ["airbyte"],
    "dbt": ["dbt"],
    "spark": ["spark", "pyspark", "apache spark"],
    "kafka": ["kafka"],
    "hadoop": ["hadoop", "hdfs", "hive"],
    "flink": ["flink"],
    "big data": ["big data", "bigdata"],
    "databricks": ["databricks"],
    "snowflake": ["snowflake"],
    "bigquery": ["bigquery", "big query"],
    "synapse": ["synapse", "azure synapse"],
    "microsoft fabric": ["microsoft fabric", "ms fabric"],
    "data warehouse": ["data warehouse", "data warehouses", "data warehousing", "datawarehouse",
                       "entrepot de donnees", "entrepots de donnees", "data lake", "data lakes",
                       "datalake", "lakehouse"],
    "tableau": ["tableau", "tableau software"],
    "looker": ["looker", "looker studio"],
    "gcp": ["gcp", "google cloud", "google cloud platform"],
    # development, cloud and DevOps
    "javascript": ["javascript", "js"],
    "html/css": ["html", "html5", "css", "css3"],
    "c#": ["c#", ".net", "dotnet", "asp.net"],
    "django": ["django"],
    "fastapi": ["fastapi"],
    "microservices": ["microservices", "microservice", "micro-services", "micro-service"],
    "linux": ["linux", "ubuntu", "debian", "red hat", "redhat", "centos"],
    "bash": ["bash", "shell scripting"],
    "powershell": ["powershell"],
    "git": ["git", "github", "gitlab", "bitbucket"],
    "jenkins": ["jenkins"],
    "github actions": ["github actions"],
    "azure devops": ["azure devops"],
    "ansible": ["ansible"],
    "helm": ["helm"],
    "infrastructure as code": ["infrastructure as code", "infrastructure-as-code", "iac"],
    "monitoring": ["monitoring", "observability", "observabilite", "prometheus", "grafana", "datadog",
                   "zabbix", "nagios"],
    "elasticsearch": ["elasticsearch", "elk", "elk stack", "opensearch", "logstash", "kibana"],
    "mlops": ["mlops", "kubeflow", "mlflow"],
    # AI
    "langchain": ["langchain"],
    "tensorflow": ["tensorflow"],
    "pytorch": ["pytorch"],
    "scikit-learn": ["scikit-learn", "sklearn"],
    # business tools and methods
    "salesforce": ["salesforce", "lightning web components", "lwc", "soql", "agentforce"],
    "power platform": ["power platform", "power automate", "power apps", "powerapps"],
    "sharepoint": ["sharepoint"],
    "jira": ["jira"],
    "agile": ["agile", "scrum", "kanban", "agilite", "methode agile", "methodes agiles"],
    # tools named on olivesoft.fr (services, partners, case studies)
    "qlik": ["qlik", "qlik sense", "qlikview"],
    "mulesoft": ["mulesoft", "anypoint"],
    "boomi": ["boomi"],
    "workato": ["workato"],
    "n8n": ["n8n"],
    "make": ["make.com", "integromat"],
    "vertex ai": ["vertex ai", "google vertex ai"],
    "azure machine learning": ["azure machine learning", "azure ml"],
    "langgraph": ["langgraph"],
    "sap successfactors": ["sap successfactors", "successfactors"],
    "cegid": ["cegid"],
    "sage x3": ["sage x3"],
    "dataform": ["dataform"],
    "deep learning": ["deep learning"],
    "nlp": ["nlp", "natural language processing"],
    "computer vision": ["computer vision"],
    "generative ai": ["generative ai", "genai", "gen ai", "ia generative"],
    "chatbot": ["chatbot", "chatbots", "conversational agent"],
}

# A document that has the key skill also has these (someone who uses Talend does ETL).
# Used on documents only: a requirement asking for "Talend" still needs Talend.
IMPLIES = {
    "talend": ["etl"], "ssis": ["etl"], "nifi": ["etl"], "airbyte": ["etl"], "dbt": ["etl"],
    "azure data factory": ["etl", "azure"],
    "spark": ["big data"], "hadoop": ["big data"], "kafka": ["big data"], "flink": ["big data"],
    "databricks": ["spark", "big data"],
    "bigquery": ["gcp", "data warehouse"], "snowflake": ["data warehouse"], "synapse": ["azure", "data warehouse"],
    "microsoft fabric": ["azure"],
    "terraform": ["infrastructure as code"], "ansible": ["infrastructure as code"], "helm": ["kubernetes"],
    "jenkins": ["ci/cd"], "github actions": ["ci/cd"], "azure devops": ["ci/cd", "azure"],
    "power bi": ["dashboard"], "tableau": ["dashboard"], "looker": ["dashboard"], "qlik": ["dashboard"],
    "mulesoft": ["etl"], "boomi": ["etl"], "workato": ["etl"],
    "vertex ai": ["gcp", "machine learning"], "azure machine learning": ["azure", "machine learning"],
    "langgraph": ["llm"], "deep learning": ["machine learning"], "generative ai": ["artificial intelligence"],
    "postgresql": ["sql"], "mysql": ["sql"],
    "react": ["javascript"], "angular": ["javascript"], "vue": ["javascript"], "node.js": ["javascript"],
    "typescript": ["javascript"],
    "spring": ["java"], "laravel": ["php"], "django": ["python"], "fastapi": ["python"],
    "langchain": ["llm"], "tensorflow": ["machine learning"], "pytorch": ["machine learning"],
    "scikit-learn": ["machine learning"], "mlops": ["machine learning"],
}

CERTIFICATIONS = {
    "PMP": ["pmp", "project management professional"],
    "PRINCE2": ["prince2"],
    "ISO 27001": ["iso 27001", "iso/iec 27001", "iso27001"],
    "ITIL": ["itil"],
    "TOGAF": ["togaf"],
    "AWS Certified": ["aws certified", "aws certification", "certified aws"],
    "AWS Solutions Architect": ["aws certified solutions architect", "aws solutions architect"],
    # Azure has one certificate per exam: a fundamentals exam (AZ-900) is not the architect one (AZ-305).
    # "Azure Certified" is any of them (see CERT_FAMILIES).
    "Azure Certified": ["microsoft certified azure", "microsoft certified: azure", "azure certified",
                        "azure certification"],
    "Azure Fundamentals (AZ-900)": ["az-900", "azure fundamentals"],
    "Azure Administrator (AZ-104)": ["az-104", "azure administrator associate"],
    "Azure Developer (AZ-204)": ["az-204", "azure developer associate"],
    "Azure Solutions Architect (AZ-305)": ["az-305", "azure solutions architect"],
    "Azure DevOps Engineer (AZ-400)": ["az-400", "microsoft certified: devops engineer expert",
                                       "azure devops engineer expert"],
    "Azure Data Fundamentals (DP-900)": ["dp-900", "azure data fundamentals"],
    "Azure AI Fundamentals (AI-900)": ["ai-900", "azure ai fundamentals"],
    "Azure AI Engineer (AI-102)": ["ai-102", "azure ai engineer associate"],
    "Azure Data Engineer": ["azure data engineer associate", "microsoft certified: data engineer associate",
                            "dp-203"],
    "Power BI Data Analyst (PL-300)": ["pl-300", "data analyst associate", "power bi data analyst",
                                       "powerbi data analyst"],
    "Fabric Analytics Engineer (DP-600)": ["dp-600", "fabric analytics engineer"],
    "GCP Professional Data Engineer": ["professional data engineer", "gcp professional data engineer"],
    "Google Cloud Certified": ["google cloud certified", "google cloud certification",
                               "google cloud professional"],
    "Databricks Certified": ["databricks certified", "databricks certification",
                             "databricks associate data engineer"],
    "Talend Certified": ["talend certified", "talend certification", "certification (talend)",
                         "certified talend"],
    "Airflow Certified": ["airflow certified", "airflow certification", "astronomer certification",
                          "airflow fundamentals", "airflow 3 fundamentals"],
    "Salesforce Certified": ["salesforce certified", "certified salesforce", "salesforce certification",
                             "salesforce certifie", "salesforce marketing cloud email specialist",
                             "agentforce specialist"],
    # Salesforce has one certificate per job: an administrator is not a developer.
    "Salesforce Administrator": ["certified salesforce administrator", "salesforce certified administrator",
                                 "salesforce administrator certification", "salesforce administrator certified"],
    "Salesforce Platform Developer": ["salesforce platform developer", "salesforce certified platform developer",
                                      "platform developer i", "platform developer ii"],
    "CKA": ["cka", "certified kubernetes administrator"],
    "CCNP": ["ccnp"],
    "CEH": ["ceh"],
    "Fortinet NSE": ["fortinet nse", "nse 4"],
    "ISTQB": ["istqb"],
    # Scrum.org (PSM, PSPO) and Scrum Alliance (CSM, CSPO) are two different certificates for the
    # same job. "Scrum Master (PSM/CSM)" is either one: "certified Scrum Master" written without
    # the acronym does not say which.
    "Scrum Master (PSM/CSM)": ["certified scrum master", "scrum master certified", "scrum master certification",
                               "scrum master certificate", "scrum master certifie", "certification scrum master"],
    "Professional Scrum Master (PSM)": ["psm", "psm i", "psm ii", "psm iii", "professional scrum master"],
    "Certified Scrum Master (CSM)": ["csm", "a-csm"],
    "Product Owner (PSPO/CSPO)": ["certified scrum product owner", "certified product owner",
                                  "product owner certified", "product owner certification",
                                  "product owner certifie", "certification product owner"],
    "Professional Scrum Product Owner (PSPO)": ["pspo", "pspoi", "pspo i", "pspo ii",
                                                "professional scrum product owner"],
    "Certified Scrum Product Owner (CSPO)": ["cspo", "a-cspo"],
    "Certified Trainer": ["formateur certifie", "certified trainer", "cnfcpp"],
}

# A specific certificate also counts as its family's general one: a PSM holder is
# "Scrum Master (PSM/CSM)" certified, an AZ-104 holder is "Azure Certified".
# A requirement that names the specific certificate needs it; one that only names the
# family ("certified Scrum Master", "Azure certified") accepts any member.
CERT_FAMILIES = {
    "Scrum Master (PSM/CSM)": ["Professional Scrum Master (PSM)", "Certified Scrum Master (CSM)"],
    "Product Owner (PSPO/CSPO)": ["Professional Scrum Product Owner (PSPO)", "Certified Scrum Product Owner (CSPO)"],
    "AWS Certified": ["AWS Solutions Architect"],
    "Azure Certified": ["Azure Fundamentals (AZ-900)", "Azure Administrator (AZ-104)", "Azure Developer (AZ-204)",
                        "Azure Solutions Architect (AZ-305)", "Azure DevOps Engineer (AZ-400)",
                        "Azure Data Engineer", "Azure Data Fundamentals (DP-900)",
                        "Azure AI Fundamentals (AI-900)", "Azure AI Engineer (AI-102)"],
    "Google Cloud Certified": ["GCP Professional Data Engineer"],
    "Salesforce Certified": ["Salesforce Administrator", "Salesforce Platform Developer"],
}

# Certificates that prove the same job for another certification body. A holder of one only
# partly meets a requirement that names the other: the buyer must accept the equivalence.
# The family name is listed too: "Certified Scrum Master" without CSM or PSM may be either.
EQUIVALENT_CERTS = {
    "Professional Scrum Master (PSM)": ["Certified Scrum Master (CSM)", "Scrum Master (PSM/CSM)"],
    "Certified Scrum Master (CSM)": ["Professional Scrum Master (PSM)", "Scrum Master (PSM/CSM)"],
    "Professional Scrum Product Owner (PSPO)": ["Certified Scrum Product Owner (CSPO)", "Product Owner (PSPO/CSPO)"],
    "Certified Scrum Product Owner (CSPO)": ["Professional Scrum Product Owner (PSPO)", "Product Owner (PSPO/CSPO)"],
}

ROLES = {
    "developer": ["developer", "developers", "developpeur", "developpeurs", "full-stack", "backend engineer", "front-end developer"],
    "project manager": ["project manager", "project managers", "chef de projet", "chefs de projet", "program manager"],
    "designer": ["designer", "designers"],
    "devops": ["devops"],
    "data engineer": ["data engineer", "data engineers", "ingenieur data", "ingenieurs data"],
    "cloud architect": ["cloud architect", "cloud architects", "architecte cloud"],
    "security consultant": ["cybersecurity", "security consultant", "security consultants", "securite"],
    "network engineer": ["network engineer", "network engineers"],
    "qa engineer": ["qa", "quality assurance", "tester", "testeur"],
    "trainer": ["trainer", "trainers", "formateur", "formateurs"],
    "scrum master": ["scrum master", "scrum masters"],
    "ai engineer": ["ai engineer", "ai engineers", "machine learning engineer", "machine learning engineers"],
    # added for the sample OliveSoft CVs
    "product owner": ["product owner", "product owners", "responsable produit"],
    "business analyst": ["business analyst", "business analysts", "analyste metier", "analyste fonctionnel",
                         "functional analyst"],
    "data analyst": ["data analyst", "data analysts", "analyste de donnees", "bi analyst"],
    "bi consultant": ["bi consultant", "bi consultants", "bi developer", "consultant bi", "developpeur bi",
                      "business intelligence consultant", "business intelligence developer"],
    "cloud engineer": ["cloud engineer", "cloud engineers", "cloud infrastructure engineer",
                       "cloud and devops engineer", "ingenieur cloud"],
    "data scientist": ["data scientist", "data scientists"],
    "mlops engineer": ["mlops engineer", "mlops engineers"],
    "delivery manager": ["delivery manager", "delivery managers"],
    "team lead": ["team lead", "team leader", "tech lead", "technical lead", "lead developer", "chef d'equipe"],
    "architect": ["enterprise architect", "data architect", "software architect", "architecte logiciel",
                  "architecte d'entreprise"],
}

# A person holding one of these certificates can fill this role, even if their job
# title says something else ("Managing Partner" with a PMP can act as project manager).
CERT_ROLES = {
    "PMP": ["project manager"],
    "PRINCE2": ["project manager"],
    # Any Scrum Master (PSM or CSM) or Product Owner (PSPO or CSPO) certificate, see CERT_FAMILIES.
    "Scrum Master (PSM/CSM)": ["scrum master"],
    "Product Owner (PSPO/CSPO)": ["product owner"],
}
# A person in the key role can also fill these roles.
ROLE_IMPLIES = {
    "delivery manager": ["project manager"],
}

SECTORS = {
    "public": ["public sector", "secteur public", "government", "gouvernement", "ministry", "ministere",
               "municipality", "municipalite", "public agency", "agence publique", "universite publique", "national"],
    "tourism": ["tourism", "tourisme", "hotel", "hotels"],
    "health": ["health", "sante", "hospital", "hopital"],
    "finance": ["bank", "banque", "insurance", "assurance", "finance"],
    "telecom": ["telecom"],
    "education": ["university", "universite", "education", "school"],
    "retail": ["retail", "retailer", "e-commerce", "fashion", "luxury", "luxe", "pret-a-porter"],
    "industry": ["manufacturer", "industrial", "industrie"],
    "energy": ["energy", "energie", "electricity", "electricite", "power grid"],
    "transport": ["transport", "motorway", "autoroute", "mobility", "mobilite"],
    "media": ["media", "medias", "publishing", "edition", "publisher"],
}

# Words that carry no specific need. If a requirement has other words left
# after removing these and the known terms, we cannot decide it with rules alone.
GENERIC_WORDS = set("""
a an the of for in on with and or to at by as is are be au aux de des du le la les un une et ou en
pour sur avec dans par
minimum min least at-least moins plus previous prior past experience experiences experienced required
requis exigee exigees preferred prefere preferee souhaite souhaitee desired nice have must
senior seniors junior juniors mid lead confirmed confirme confirmes
certified certification certifications certifie certifiee certifies certifiees
programme programmes program programs similar similaire similaires comparable reference references
session sessions fondamentaux fundamentals basics bases introduction atelier ateliers workshop workshops pratique pratiques practical hands-on app apps
developer developers developpeur developpeurs engineer engineers ingenieur ingenieurs
project projects projet projets manager managers chef team equipe member members profile profiles
designer designers digital numerique numeriques sector secteur secteurs public publics publique
frontend front-end front end backend back-end back database base donnees hosting hebergement cloud
platform plateforme solution solutions system systems systeme systemes years ans year an
development developpement using based skills skill competences competence knowledge connaissance
expert experts specialist specialiste specialise specialises specialized
informatique informatiques it software logiciel logiciels tool tools outil outils application applications
acquisition supply fourniture implementation mise place deploiement deployment
pipeline pipelines materiel materiels hardware equipment equipments equipement equipements
microsoft google amazon apache
""".split())

# Words that only say what part of a named technology is meant ("Angular interface", "REST API exposure",
# "Node.js server", "interface Angular"): there the technology is the need and these words add nothing.
# Anywhere else they are the need ("API integration", "Python web development", "Java web services
# integration"). See leftover_tokens(): only a word directly attached to a skill or certificate name,
# at the end of that name's phrase, is dropped.
CONTEXT_WORDS = set("""
interface interfaces server servers serveur serveurs exposure exposition expose layer layers couche couches
api apis web module modules component components composant composants service services
integration integrations architecture architectures stack stacks environment environments environnement
""".split())

# Words that end a phrase: after "Angular interface" in "Angular interface with SSO", "Angular interface
# experience", "interface Angular de ..." the context word cannot be part of a longer name such as
# "web services". Function words and the filler words of a requirement.
PHRASE_BREAKS = set("""
a an the of for in on with and or to at by as is are be from via using into within including such like
de des du d l le la les un une et ou en pour sur avec dans par au aux sous chez
experience experiences experienced expertise knowledge skill skills competence competences connaissance
connaissances required requis requise mandatory obligatoire preferred desired souhaite souhaitee minimum
""".split())

# Plain words that describe a need, not a product. Together with the words the documents write in
# lowercase (see unknown_names), they tell "orchestration" from "hibernate" or "openshift" written in
# lowercase: a product name is neither a common word nor a lowercase word of the documents.
COMMON_WORDS = set("""
analysis analytics administration architecture assessment audit automation availability backup batch
business capacity change cluster clusters collaboration communication compliance configuration consulting
containers continuity coordination cost customer customers dashboarding data delivery demand deployment
design documentation engineering estimation evaluation forecasting governance hardening incident
infrastructure installation integration interoperability inventory logistics loyalty maintenance management
methodology migration mobile modelling modeling monitoring network networks operations optimisation
optimization orchestration orders payroll performance planning portal processing procurement production
programming provisioning quality real-time recovery reporting resilience retention risk sales scalability
scheduling scripting search security semantic storage streaming strategy studies study supervision support
supply testing traceability training transformation tuning upgrade validation virtualisation virtualization
visualisation visualization warehouse workflow workflows
""".split())

def normalize(text: str) -> str:
    """lowercase, remove accents, unify quotes and spaces."""
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("’", "'")
    return re.sub(r"\s+", " ", text).strip()


def _find(table: dict, text: str) -> list[str]:
    t = f" {normalize(text)} "
    found = []
    for name, aliases in table.items():
        for a in aliases:
            if re.search(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])", t):
                found.append(name)
                break
    return found


def _no_dashboard_tableau(text: str) -> str:
    # French "tableau de bord" means dashboard, not the Tableau software.
    return re.sub(r"tableaux? de bords?", "dashboard", normalize(text))


def find_skills(text):
    text = _no_dashboard_tableau(text)
    found = _find(SKILLS, text)
    # "react native" also matches "react"; keep both only if plain React is written elsewhere.
    if "react native" in found and not re.search(r"react(?! native)", text):
        found.remove("react")
    return found


def expand_skills(skills):
    """Add the skills implied by the ones found (Talend -> ETL). For documents only."""
    out, todo = list(skills), list(skills)
    while todo:
        for extra in IMPLIES.get(todo.pop(), []):
            if extra not in out:
                out.append(extra)
                todo.append(extra)
    return out


def implied_by(skill):
    """Skills that imply this one: implied_by("etl") -> ["talend", "ssis", ...]."""
    return [s for s, extras in IMPLIES.items() if skill in extras]


def implied_roles(roles, certs):
    """Roles a person can also fill, with the reason: {"project manager": "PMP certification"}."""
    extra = {}
    for cert in certs:
        for role in CERT_ROLES.get(cert, []):
            if role not in roles:
                extra.setdefault(role, f"{cert} certification")
    for held in roles:
        for role in ROLE_IMPLIES.get(held, []):
            if role not in roles:
                extra.setdefault(role, f"{held} role")
    return extra


def role_proof_terms(role):
    """Words that prove a role, including the certificates and roles that imply it."""
    terms = list(ROLES.get(role, []))
    terms += [a for cert, roles in CERT_ROLES.items() if role in roles for a in cert_aliases(cert)]
    terms += [a for held, roles in ROLE_IMPLIES.items() if role in roles for a in ROLES[held]]
    return terms


def has_or(text):
    """True when the sentence offers a choice ("React or Angular", "React/Angular", "Java, Python")."""
    t = normalize(text)
    for table in (SKILLS, CERTIFICATIONS):   # "ci/cd", "pl/sql", "iso/iec" are names, not choices
        for aliases in table.values():
            for a in aliases:
                if "/" in a:
                    t = t.replace(a, " ")
    return bool(re.search(r"\b(or|ou)\b|\w\s*/\s*\w|,", t))


def find_certs(text):
    """Certifications named in the text, plus the family of each one (PSM -> Scrum Master (PSM/CSM))."""
    found = _find(CERTIFICATIONS, text)
    for family, members in CERT_FAMILIES.items():
        if family not in found and any(m in found for m in members):
            found.append(family)
    return found


def specific_certs(certs):
    """Drop a family when one of its members is named too.

    "1 PSM certified Scrum Master" names the PSM and the words "certified Scrum Master":
    it asks for the PSM, not for any Scrum Master certificate.
    """
    return [c for c in certs if not any(m in certs for m in CERT_FAMILIES.get(c, []))]


def same_cert_family(a, b):
    """True when both certificates belong to one CERT_FAMILIES group (PSM and CSM, AZ-104 and AZ-305)."""
    return any(a in group and b in group for group in ([f, *members] for f, members in CERT_FAMILIES.items()))


def equivalent_certs(cert):
    """Certificates that only partly meet a requirement for this one (CSM for PSM)."""
    return EQUIVALENT_CERTS.get(cert, [])


def cert_aliases(cert):
    """The ways a certificate is written, with those of its family members.

    A CV line "Professional Scrum Product Owner I (PSPO I)" proves "Product Owner certified"
    (the family "Product Owner (PSPO/CSPO)") as well as the PSPO itself.
    """
    return CERTIFICATIONS[cert] + [a for m in CERT_FAMILIES.get(cert, []) for a in CERTIFICATIONS[m]]


def find_roles(text):
    return _find(ROLES, text)


def find_sectors(text):
    return _find(SECTORS, text)


def strip_aliases(text: str, table: dict) -> str:
    """The normalized text without the names in this table (longest names first)."""
    t = normalize(text)
    for a in sorted((a for aliases in table.values() for a in aliases), key=len, reverse=True):
        t = re.sub(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])", " ", t)
    return t


# French tender words -> the English words used in the documents (CVs and records are in English).
# Applied only to the words the vocabulary does not know, so "Streaming temps reel" is checked as
# "streaming real-time" in an English CV. Keep entries general; skill/role names belong in the tables above.
FR_EN = {
    "temps reel": "real-time", "mode": "fashion", "luxe": "luxury", "pret-a-porter": "fashion",
    "prevision": "forecasting", "previsions": "forecasting", "demande": "demand", "ventes": "sales", "vente": "sales",
    "donnees": "data", "entrepot": "warehouse", "chaine logistique": "supply chain", "logistique": "logistics",
    "fidelite": "loyalty", "clients": "customers", "commandes": "orders", "commande": "order", "paie": "payroll",
    "ressources humaines": "human resources", "nuage": "cloud", "conteneurs": "containers", "conteneur": "container",
    "migration": "migration", "assistant": "assistant", "generative": "generative",
}


def translate_fr(text: str) -> str:
    """Replace known French tender words by their English equivalents (normalized text)."""
    t = normalize(text)
    for fr in sorted(FR_EN, key=len, reverse=True):
        t = re.sub(rf"(?<![a-z0-9]){re.escape(fr)}(?![a-z0-9])", FR_EN[fr], t)
    return t


TECH, OTHER = "\x00", "\x01"     # stand for a skill or certificate name / a role or sector name


def _names_marked(text: str) -> str:
    """The translated, normalized text with each known name replaced by TECH or OTHER."""
    t = translate_fr(_no_dashboard_tableau(text))
    tech = {a for table in (SKILLS, CERTIFICATIONS) for aliases in table.values() for a in aliases}
    names = tech | {a for table in (ROLES, SECTORS) for aliases in table.values() for a in aliases}
    # Longest names first, across all tables: "scrum master" before "scrum".
    for a in sorted(names, key=len, reverse=True):
        t = re.sub(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])", f" {TECH if a in tech else OTHER} ", t)
    return t


def leftover_tokens(text: str) -> list[tuple[str, bool]]:
    """leftover_words(text), each with True when it is a context word that qualifies a named skill or certificate.

    The context word (CONTEXT_WORDS) must be directly attached to the name and end its phrase on that
    side: "Angular interface", "REST API exposure.", "Node.js server with ...", "interface Angular".
    Not in "Python web development" or "Java web services integration", where "web" is part of
    "web development" / "web services", and never through another word ("services" is not attached
    to "Java"): those words stay the need.
    """
    # Words as leftover_words always read them; numbers and signs are tokens too.
    tokens = re.findall(r"[\x00\x01]|[a-z][a-z0-9+#./-]*|[0-9]+|[^\sa-z0-9]", _names_marked(text))

    def ends_phrase(j):
        if j < 0 or j >= len(tokens) or tokens[j] in (TECH, OTHER) or not tokens[j][0].isalpha():
            return True                   # start or end of the text, a name, a sign or a number
        return tokens[j].strip("./-") in PHRASE_BREAKS

    out = []
    for i, tok in enumerate(tokens):
        word = tok.strip("./-")
        if not tok[0].isalpha() or word in GENERIC_WORDS or len(word) <= 1:
            continue
        attached = word in CONTEXT_WORDS and (
            (i > 0 and tokens[i - 1] == TECH and (tok.endswith(".") or ends_phrase(i + 1)))
            or (i + 1 < len(tokens) and tokens[i + 1] == TECH and ends_phrase(i - 1)))
        out.append((tok, attached))
    return out


def leftover_words(text: str) -> list[str]:
    """Words not explained by known skills, certs, roles, sectors or generic words."""
    return [w for w, _ in leftover_tokens(text)]


def _plain_text(text: str) -> str:
    raw = unicodedata.normalize("NFKD", text or "")
    return "".join(c for c in raw if not unicodedata.combining(c))


def lowercase_words(texts) -> set[str]:
    """The words written in lowercase in these texts, accents removed ("orchestration", not "OpenShift")."""
    out = set()
    for text in texts:
        out.update(t.strip("./-") for t in re.findall(r"[A-Za-z][A-Za-z0-9+#./-]*", _plain_text(text))
                   if t.islower())
    return out


def word_forms(word: str) -> set[str]:
    """The word as written plus its plural / -ing / -ed forms ("test": tests, testing, tested).

    Only suffixes are added: "dynamics" is never "dynamic".
    """
    w = word.strip("./-")
    forms = {w, w + "s", w + "es", w + "ing", w + "ed", w + "d"}
    if w.endswith("e"):
        forms.add(w[:-1] + "ing")         # "schedule": scheduling
    if w.endswith("y") and len(w) > 2:
        forms.update({w[:-1] + "ies", w[:-1] + "ied"})   # "study": studies
    return forms


def is_plain_word(word: str, corpus_words) -> bool:
    """True when the word describes a need: a common word, or one the documents write in lowercase."""
    w = word.strip("./-")
    return (w in COMMON_WORDS or w in CONTEXT_WORDS or w in GENERIC_WORDS
            or any(f in corpus_words for f in word_forms(w)))


def unknown_names(text: str, words: list[str], corpus_words=None) -> list[str]:
    """The words (from leftover_words) that look like the name of a product or technology.

    A name has a capital letter ("iOS", "Swift", "COBOL"), a digit or a sign ("S/4HANA", "365", "C++").
    A plain lowercase word ("orchestration", "banking") describes the need instead.
    When the text is written all in lowercase or all in capitals, the case says nothing:
    every word may be a name.
    With corpus_words (the words the indexed documents write in lowercase, see lowercase_words),
    a word is also a name unless it is a plain word (is_plain_word): a product written in lowercase
    ("hibernate", "openshift", "nomad", "ios") is a common word nowhere and no document writes it so.
    """
    tokens = re.findall(r"[A-Za-z][A-Za-z0-9+#./-]*", _plain_text(text))
    if not any(t.islower() for t in tokens) or not any(not t.islower() for t in tokens):
        names = list(words)
    else:
        plain = {t.lower() for t in tokens if t.islower() and not re.search(r"[0-9+#./]", t)}
        names = [w for w in words if w not in plain]
    if corpus_words is not None:
        names = [w for w in words if w in names or not is_plain_word(w, corpus_words)]
    return names
