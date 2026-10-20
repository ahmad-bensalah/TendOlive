# n8n Setup & Agent Development Guide

Welcome to the n8n agent setup guide! This guide will help you set up n8n, connect it to the local RFP Slide Deck Studio, configure Groq LLM credentials, and build your first agent workflow.

---

## 1. Install & Run n8n

You can run n8n either locally via npm/npx or using Docker.

### Option A: Native Install (npm / npx) [Verified]
Requires Node.js 18+. Run in a terminal:
```bash
npx n8n
```

### Option B: Docker [Verified]
To run n8n inside Docker with persistent storage and network access:
```bash
docker run -it --rm \
  --name n8n \
  -p 5678:5678 \
  -v ~/.n8n:/home/node/.n8n \
  --add-host=host.docker.internal:host-gateway \
  docker.n8n.io/n8nio/n8n
```
*(Note: `--add-host=host.docker.internal:host-gateway` allows containers on Linux to reach services running on the host machine).*

### Access the Web Interface
Open your browser at: **[http://localhost:5678](http://localhost:5678)**

---

## 2. Reaching the Studio Editor from n8n

Depending on how n8n is running, use the appropriate base URL:
- **Native install (npx n8n)**:
  - Base URL: `http://localhost:8091`
- **Docker container**:
  - Base URL: `http://host.docker.internal:8091`
  *(On Linux, ensure the container was started with `--add-host=host.docker.internal:host-gateway`).*

---

## 3. Configuring Credentials in n8n

### Credential 1: Studio API Key ("Studio") [Verified]
1. In n8n, navigate to **Credentials** > **New Credential**.
2. Select **Header Auth**.
3. Fill in:
   - **Credential Name**: `Studio`
   - **Name**: `X-API-Key`
   - **Value**: Your studio key (see `START_HERE.md` for the shared local dev key).
4. Save the credential.

### Credential 2: Groq Cloud API [Verified]
There are two ways to connect Groq depending on your n8n version:

#### Method A: Built-in Groq Credential / Chat Model Node *(if available in your n8n version)* [Not verified on older n8n versions]
1. Under **Credentials**, search for **Groq API**.
2. Paste your `GROQ_API_KEY`.
3. In your workflow, add the **Groq Chat Model** node and enter your model name (e.g. `llama-3.3-70b-versatile` or whatever is defined in `GROQ_MODEL`).

#### Method B: Universal HTTP Request Node *(works on all versions)* [Verified]
1. Under **Credentials**, create a new **Header Auth** credential named `Groq API`.
2. Configure:
   - **Name**: `Authorization`
   - **Value**: `Bearer <YOUR_GROQ_API_KEY>` *(replace with your actual key)*.
3. In your workflow HTTP Request node:
   - **Method**: `POST`
   - **URL**: `https://api.groq.com/openai/v1/chat/completions`
   - **Credential for Auth**: Header Auth (`Groq API`)
   - **Body**: JSON containing `"model": "llama-3.3-70b-versatile"` and your prompt messages.

---

## 4. Groq Integration Best Practices

1. **Structured JSON Output**: Always set `"response_format": {"type": "json_object"}` in your request body so the LLM outputs strict JSON instead of conversational markdown.
2. **Rate Limits & Retries (HTTP 429)**: Free/dev Groq tiers enforce per-minute rate limits. If a request returns HTTP 429, n8n can automatically retry:
   - In the HTTP Request node settings, enable **Retry On Fail**.
   - Set max tries to `3` and wait between tries to `15000` ms (15s) or inspect the `Retry-After` header.
3. **Model Naming**: Groq periodically updates active model versions. Always verify the current model names in the [Groq Console](https://console.groq.com/docs/models) and set `GROQ_MODEL` accordingly. When using `tools/check_llm.py`, export these variables in your terminal (`export GROQ_API_KEY="..." ; export GROQ_MODEL="..."` on Linux/macOS, or `set GROQ_API_KEY=... & set GROQ_MODEL=...` on Windows cmd; do not use a .env file as scripts do not parse .env).

---

## 5. Step-by-Step: Your First Test Workflow

Build a simple test workflow in n8n to verify communication with the Studio:

1. **Add a Manual Trigger**:
   - Create a new workflow.
   - Add a **Manual Trigger** node (the "When clicking 'Test workflow'" trigger).
2. **Add a Code Node** (loads test tender data):
   - Add a **Code** node connected to the trigger.
   - Language: **JavaScript**.
   - Paste the sample JSON payload from `samples/software.json` returning `return [{ json: { ... } }];`.
3. **Add an HTTP Request Node** (sends to Studio):
   - Connect the Code node to an **HTTP Request** node.
   - **Method**: `POST`
   - **URL**: `http://localhost:8091/api/decks` (or `http://host.docker.internal:8091/api/decks` if inside Docker).
   - **Authentication**: **Predefined Credential Type** > **Header Auth** > select `Studio`.
   - **Send Body**: Yes, format: **JSON**, specify input data from previous node.
4. **Execute and Verify**:
   - Click **Test step** or **Execute Workflow**.
   - Check the response:
     ```json
     {
       "id": "a699e358",
       "url": "/editor.html?id=a699e358",
       "warnings": []
     }
     ```
   - Open `http://localhost:8091/editor.html?id=a699e358` in your browser to view your newly created deck!

---

## 6. Exporting Your Workflows

When your agent workflow is ready:
1. In n8n, click the three-dot menu `...` > **Download** / **Export**.
2. Save the exported JSON file to `workflows/` (e.g. `workflows/credibility.json`).
3. **CRITICAL SECURITY RULE**: Ensure no private API keys or tokens are stored in the workflow JSON before committing or sharing.
