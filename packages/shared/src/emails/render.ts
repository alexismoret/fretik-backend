import Handlebars from "handlebars";
import mjml from "mjml";

import { i18n } from "./i18n";

const LOGO_URL =
  "https://s3.fr-par.scw.cloud/files.fretik.com/public/logo-icon.png";

const templatesDir = `${import.meta.dir}/templates`;

const templateCache = new Map<string, HandlebarsTemplateDelegate>();

const readTemplate = async (name: string): Promise<string> => {
  return Bun.file(`${templatesDir}/${name}.mjml`).text();
};

const getCompiledTemplate = async (
  name: string,
): Promise<HandlebarsTemplateDelegate> => {
  const cached = templateCache.get(name);
  if (cached && process.env.NODE_ENV === "production") {
    return cached;
  }

  const source = await readTemplate(name);
  const compiled = Handlebars.compile(source);
  templateCache.set(name, compiled);
  return compiled;
};

const getBaseData = (lang: string): Record<string, string> => ({
  logoUrl: LOGO_URL,
  appName: i18n.t("base.appName", { lng: lang }),
  footerCopyright: i18n.t("base.footer.copyright", {
    lng: lang,
    year: String(new Date().getFullYear()),
  }),
  footerSentBy: i18n.t("base.footer.sentBy", { lng: lang }),
});

/**
 * Renders an email template to HTML.
 *
 * 1. Compiles the child template with Handlebars (data + i18n)
 * 2. Injects the result into base.mjml's `{{{content}}}` slot
 * 3. Compiles the full MJML document with Handlebars (base data)
 * 4. Converts MJML to HTML
 */
export const renderEmail = async (
  templateName: string,
  data: Record<string, unknown>,
  lang: string,
): Promise<string> => {
  const baseData = getBaseData(lang);
  const mergedData = { ...baseData, ...data };

  const childTemplate = await getCompiledTemplate(templateName);
  const childHtml = childTemplate(mergedData);

  const baseSource = await readTemplate("base");
  const fullMjml = baseSource.replace("{{{content}}}", childHtml);

  const compiledFull = Handlebars.compile(fullMjml);
  const finalMjml = compiledFull(mergedData);

  // mjml v5 made `mjml2html` async (Promise<{html, errors}>) but
  // @types/mjml@5 still ships the v4 synchronous signature. Without
  // the await, `errors` was `undefined` (we destructured the Promise
  // itself), and `errors.length` threw `undefined is not an object`
  // inside `email-on-finish`. `Promise.resolve()` is the cast-free
  // way to satisfy oxlint's `await-thenable` rule (no `as` allowed
  // in backend per root CLAUDE.md).
  const { html, errors } = await Promise.resolve(mjml(finalMjml));
  if (errors.length > 0) {
    console.error("[Email] MJML compilation errors:", errors);
  }

  return html;
};
