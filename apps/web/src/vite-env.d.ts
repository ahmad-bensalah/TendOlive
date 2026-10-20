/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The proposal studio (rfp-studio) the browser calls directly; http://localhost:8091 when unset. */
  readonly VITE_STUDIO_URL?: string
  /** Our n8n, whose "RFP - Refine Slide" webhook the deck page calls directly; http://localhost:5679 when unset. */
  readonly VITE_N8N_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
