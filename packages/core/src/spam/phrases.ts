import type { Filter } from "./types";

/**
 * Each filter's part that needs no AI (ADR-029 §5.3): families of phrases that only unwanted
 * messages use, in many languages. They count only while their filter is on, and only on what a
 * stranger sent. A language with no family yet means less caught, never more: nothing here reads
 * which language a message is in. Phrases are matched on normalised text (`normalise`), whole words
 * only where words are spaced.
 */

interface Family {
  readonly id: string;
  readonly filter: Filter;
  readonly phrases: readonly string[];
}

const FAMILIES: readonly Family[] = [
  {
    id: "seo",
    filter: "pitches",
    phrases: [
      "first page of google",
      "page 1 of google",
      "rank higher on google",
      "improve your ranking",
      "improve your google ranking",
      "seo services",
      "seo audit",
      "seo expert",
      "search engine optimization",
      "search engine optimisation",
      "boost your traffic",
      "organic traffic",
      "primera página de google",
      "posicionamiento seo",
      "posicionamento no google",
      "primeira página do google",
      "première page de google",
      "référencement naturel",
      "erste seite bei google",
      "suchmaschinenoptimierung",
      "prima pagina di google",
      "posizionamento seo",
      "eerste pagina van google",
      "pierwsza strona google",
      "pozycjonowanie stron",
      "google'da ilk sayfa",
      "halaman pertama google",
      "上位表示",
      "seo対策",
      "谷歌排名",
      "搜索引擎优化",
      "تحسين محركات البحث",
      "गूगल के पहले पेज",
      "ukurasa wa kwanza wa google",
    ],
  },
  {
    id: "links",
    filter: "pitches",
    phrases: [
      "guest post",
      "guest posts",
      "guest posting",
      "sponsored post",
      "sponsored article",
      "backlink",
      "backlinks",
      "dofollow",
      "do-follow",
      "link insertion",
      "link building",
      "artículo patrocinado",
      "artigo patrocinado",
      "article sponsorisé",
      "gastbeitrag",
      "articolo sponsorizzato",
      "gastblog",
      "artykuł sponsorowany",
      "artikel sponsor",
      "外部リンク",
      "外链",
      "روابط خلفية",
    ],
  },
  {
    id: "web",
    filter: "pitches",
    phrases: [
      "i noticed your website",
      "i came across your website",
      "i was checking your website",
      "redesign your website",
      "website redesign",
      "your website looks outdated",
      "we build websites",
      "we design websites",
      "rediseño de su web",
      "rediseño web",
      "redesenho do seu site",
      "refonte de votre site",
      "neugestaltung ihrer website",
      "rifacimento del sito",
      "website opnieuw ontwerpen",
      "ホームページ制作",
      "网站建设",
      "تصميم موقعك",
    ],
  },
  {
    id: "apps",
    filter: "pitches",
    phrases: [
      "mobile app development",
      "app development services",
      "we develop mobile apps",
      "custom software development",
      "desarrollo de aplicaciones",
      "desenvolvimento de aplicativos",
      "développement d'applications",
      "app-entwicklung",
      "sviluppo di app",
      "アプリ開発",
      "app开发",
    ],
  },
  {
    id: "leads",
    filter: "pitches",
    phrases: [
      "lead generation",
      "qualified leads",
      "email list of",
      "b2b leads",
      "generate more leads",
      "appointment setting",
      "more customers for your business",
      "generación de leads",
      "geração de leads",
      "génération de leads",
      "leadgenerierung",
      "generazione di lead",
      "集客",
      "获客",
    ],
  },
  {
    id: "outsourcing",
    filter: "pitches",
    phrases: [
      "outsourcing services",
      "virtual assistant services",
      "offshore team",
      "dedicated developers",
      "white label services",
      "bookkeeping services for your business",
      "business loan",
      "merchant cash advance",
      "working capital loan",
      "pre-approved for",
      "préstamo para su negocio",
      "empréstimo para empresas",
      "prêt pour votre entreprise",
    ],
  },
  {
    id: "social",
    filter: "pitches",
    phrases: [
      "grow your instagram",
      "more followers",
      "buy followers",
      "buy reviews",
      "5-star reviews",
      "five star reviews",
      "google reviews for your business",
      "reseñas de 5 estrellas",
      "avaliações 5 estrelas",
      "avis 5 étoiles",
      "5-sterne-bewertungen",
    ],
  },
  {
    id: "invoice",
    filter: "scams",
    phrases: [
      "invoice is overdue",
      "overdue invoice",
      "unpaid invoice",
      "payment is overdue",
      "final notice",
      "outstanding balance",
      "factura vencida",
      "factura pendiente de pago",
      "fatura vencida",
      "fatura em atraso",
      "facture impayée",
      "facture en retard",
      "überfällige rechnung",
      "zahlungserinnerung",
      "fattura scaduta",
      "achterstallige factuur",
      "zaległa faktura",
      "vadesi geçmiş fatura",
      "tagihan jatuh tempo",
      "未払い請求",
      "逾期发票",
      "فاتورة متأخرة",
    ],
  },
  {
    id: "bank",
    filter: "scams",
    phrases: [
      "changed our bank details",
      "change of bank details",
      "new bank details",
      "updated bank details",
      "new banking details",
      "our bank account has changed",
      "new account details",
      "wire transfer today",
      "urgent wire transfer",
      "nuevos datos bancarios",
      "cambio de cuenta bancaria",
      "novos dados bancários",
      "alteração de dados bancários",
      "nouvelles coordonnées bancaires",
      "changement de rib",
      "neue bankverbindung",
      "geänderte bankverbindung",
      "nuove coordinate bancarie",
      "nieuwe bankgegevens",
      "nowe dane do przelewu",
      "yeni banka bilgileri",
      "rekening baru",
      "振込先変更",
      "新的银行账户",
      "تغيير الحساب البنكي",
    ],
  },
  {
    id: "gift",
    filter: "scams",
    phrases: [
      "buy gift cards",
      "purchase gift cards",
      "google play cards",
      "itunes cards",
      "steam cards",
      "send the card codes",
      "tarjetas de regalo",
      "cartões-presente",
      "cartes cadeaux",
      "geschenkkarten",
    ],
  },
  {
    id: "notice",
    filter: "scams",
    phrases: [
      "your account will be suspended",
      "your account will be closed",
      "your account has been suspended",
      "verify your account within",
      "your domain will expire",
      "domain registration expires",
      "your listing will be removed",
      "copyright infringement notice",
      "copyright strike",
      "dmca notice",
      "legal action will be taken",
      "su cuenta será suspendida",
      "sua conta será suspensa",
      "votre compte sera suspendu",
      "ihr konto wird gesperrt",
      "il tuo account verrà sospeso",
      "uw account wordt opgeschort",
      "アカウントが停止",
      "您的账户将被冻结",
      "سيتم إيقاف حسابك",
    ],
  },
  {
    id: "threat",
    filter: "scams",
    phrases: [
      "negative reviews unless",
      "bad reviews unless",
      "1-star reviews unless",
      "pay or we will post",
      "reseñas negativas a menos",
      "avaliações negativas a menos",
      "avis négatifs sauf si",
    ],
  },
  {
    id: "prize",
    filter: "scams",
    phrases: [
      "you have won",
      "you've won",
      "claim your prize",
      "lottery winner",
      "inheritance fund",
      "next of kin",
      "overpaid you",
      "refund the difference",
      "my shipper will",
      "ha ganado un premio",
      "você ganhou",
      "vous avez gagné",
      "sie haben gewonnen",
      "hai vinto",
    ],
  },
];

export interface PhraseHit {
  readonly filter: Filter;
  readonly family: string;
}

const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

/** Whether a phrase is in a text as words of its own: never inside another word ("tea" in "team"). */
export function foundWords(text: string, phrase: string): boolean {
  return found(text, phrase);
}

function found(text: string, phrase: string): boolean {
  if (!phrase) return false;
  if (UNSPACED.test(phrase)) return text.includes(phrase);
  let at = text.indexOf(phrase);
  while (at >= 0) {
    const before = at === 0 ? "" : (text[at - 1] ?? "");
    const after = text[at + phrase.length] ?? "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) return true;
    at = text.indexOf(phrase, at + 1);
  }
  return false;
}

/** The families a normalised text matches, among the filters that are on. */
export function phraseHits(normalised: string, on: ReadonlySet<Filter>): PhraseHit[] {
  const out: PhraseHit[] = [];
  for (const family of FAMILIES) {
    if (!on.has(family.filter)) continue;
    if (family.phrases.some((p) => found(normalised, p))) out.push({ filter: family.filter, family: family.id });
  }
  return out;
}

/** Whether a text asks to change where money is paid: what is checked even on a known sender. */
export function asksBankChange(normalised: string): boolean {
  return FAMILIES.some((f) => f.id === "bank" && f.phrases.some((p) => found(normalised, p)));
}

/** Rows of keys typed in a run (`qwerty`, `asdfgh`, `йцукен`) and digits counted up. */
const KEYBOARD_RUNS = ["qwerty", "asdfgh", "zxcvbn", "qwertz", "azerty", "йцукен", "фыва", "123456", "abcdef"];

/**
 * Whether a text is gibberish: most of its words random letters, or one keyboard run. Only Latin
 * letters are judged, and only text that is mostly them: a script the check cannot read is never
 * called gibberish. A word with many consonants in a row (German, Polish, Czech have them) counts
 * only when most words look so.
 */
export function isGibberish(normalised: string): boolean {
  const text = normalised.trim();
  if (!text || text.length > 400) return false;
  const latin = [...text].filter((c) => /\p{Script=Latin}/u.test(c)).length;
  const letters = [...text].filter((c) => /\p{L}/u.test(c)).length;
  if (letters === 0 || latin / letters < 0.9) return false;
  const words = text.split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
  if (words.length === 0) return false;
  if (words.length <= 3 && words.some((w) => KEYBOARD_RUNS.some((k) => w.includes(k)) && w.length <= 12)) return true;
  const odd = words.filter((w) => {
    if (w.length < 5) return false;
    if (/[bcdfghjklmnpqrstvwxz]{6,}/.test(w)) return true;
    const switches = w.match(/(?<=\p{L})\p{N}|(?<=\p{N})\p{L}/gu)?.length ?? 0;
    return w.length >= 10 && switches >= 3;
  });
  return words.length >= 3 && odd.length / words.length >= 0.6;
}
