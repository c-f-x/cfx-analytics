// Schema steps are .sql files that wrangler imports as text (wrangler.jsonc, "rules").
declare module "*.sql" {
  const text: string;
  export default text;
}
