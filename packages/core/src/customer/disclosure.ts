import type { ItemType } from "../domain/types";
import { copyFor, vars } from "./copy";
import { whatOf } from "./describe";
import { oneLine } from "./format";
import type { CustomerLang } from "./lang";
import type { CustomerPage, PageSection } from "./page";

/**
 * The two places the business tells a customer about the booking network it uses (ADR-017 §2.1, as
 * the founder decided on 23 September 2026): the short email that carries a first-time customer's code,
 * alone and a day after they first booked or ordered, with one line and a link; and the page that
 * link opens, served by the inbox in the business's name, which says which networks, what they keep
 * and how to stop. Only here may a network be named; everything else a customer reads names nobody
 * but the business (`copy.ts`).
 */
export interface DisclosureCopy {
  readonly keySubject: string;
  readonly keyThanks: (v: { what: string; type: ItemType }) => string;
  readonly keyLine: string;
  readonly keysLine: string;
  /** The line under the code: what it is for, and where to read more. */
  readonly networkLine: (url: string) => string;
  readonly privacy: Readonly<{
    title: (business: string) => string;
    heading: string;
    lead: string;
    which: string;
    none: string;
    keepsHeading: string;
    keeps: string;
    forHeading: string;
    for: string;
    stopHeading: string;
    stop: string;
    /** What a network already has, and that it cannot yet be asked to erase it; then its address. */
    askNetwork: string;
    questionsHeading: string;
    questions: string;
    /** The page the code email's own link opens: the customer can stop it here, for themselves. */
    stopMine: string;
    stopButton: string;
    stopped: (date: string) => string;
    /**
     * While new messages may be read by an automated check (ADR-041 §14): what it sees and keeps, when
     * the host's service reads (`spam`: Google's Gemini API, which does not use it to improve its
     * products and keeps it for 55 days, only to detect misuse and for what the law requires), or a service the
     * business set up itself (`spamOwn`, which says nothing of what it keeps).
     */
    spamHeading: string;
    spam: string;
    spamOwn: string;
    /**
     * While the inbox's host keeps a shared list of known spam for the inboxes it runs (ADR-041 §16):
     * that each new stranger's message is compared by its fingerprint, what this business shares
     * (`spamSharedReads`: only a word that a match wasn't spam; `spamShared`: the fingerprints of what it
     * marks as spam too), and that a fingerprint can't be turned back into the message.
     */
    spamSharedReads: string;
    spamShared: string;
  }>;
}

const EN: DisclosureCopy = {
  keySubject: "For next time",
  keyThanks: ({ what, type }) => `Thank you for ${copyFor("en").yourNoun[type]}${what ? ` ${what}` : ""}.`,
  keyLine: "If you use an assistant, it can show this code next time so we recognise you:",
  keysLine: "If you use an assistant, it can show these codes next time so we recognise you:",
  networkLine: (url) => `We use a booking network to recognise returning customers. How it works: ${url}`,
  privacy: {
    title: (business) => (business ? `Returning customers — ${business}` : "Returning customers"),
    heading: "How we recognise returning customers",
    lead: "When you book or order with us for the first time and give your email address, we send it to a booking network, which makes a code for you; we send you the code in a separate email. If you use an assistant (an app that books for you), it can show the code next time so we recognise you.",
    which: "Which network",
    none: "We do not use a booking network at the moment.",
    keepsHeading: "What the network keeps",
    keeps:
      "A code for you. Not your email address itself: only a fingerprint of it, so it can tell it is you when you come back. For each booking or order with us: how it ended (for example completed, cancelled or missed), when, and the amount. It does not get your name, your address or your messages.",
    forHeading: "What it is for",
    for: "To recognise returning customers, so businesses on the network can serve good customers faster. It never decides whether we take your booking.",
    stopHeading: "How to stop",
    stop: "You don't have to use the code: without it, nothing changes for you here. To stop us using the booking network for you, use the link in the email that brought your code, or reply to any of our emails. From then on we tell no booking network anything more about you: no code, and nothing about your bookings or orders. Your bookings, orders and our emails work as before.",
    askNetwork:
      "What a network already has about you stays with it: we cannot yet ask it to erase it. To ask about it, contact the network:",
    questionsHeading: "Questions",
    questions: "Reply to any of our emails.",
    stopMine:
      "The code is optional: without it, nothing changes for you here. If you stop, from then on we tell no booking network anything more about you: no code, and nothing about your bookings or orders, how they ended or what they cost. Your bookings, orders and our emails work as before.",
    stopButton: "Stop using it for me",
    stopped: (date) =>
      `Done. Since ${date} we tell no booking network anything more about you. Your bookings, orders and our emails work as before.`,
    spamHeading: "Keeping out spam",
    spam: "We check new messages from people we haven't heard from before, to keep unwanted messages away from our team. The check can include a reading by an automated service, which sees the message without email addresses, phone numbers or bank details. That service does not use it to improve its products, and keeps it for 55 days, only to detect misuse of the service and for disclosures the law requires. A person here can see and bring back any message the check set aside while it is kept.",
    spamOwn:
      "We check new messages from people we haven't heard from before, to keep unwanted messages away from our team. The check can include a reading by an automated service, which sees the message without email addresses, phone numbers or bank details. A person here can see and bring back any message the check set aside while it is kept.",
    spamSharedReads:
      "To keep out spam, the provider that handles our messages compares a fingerprint of each new message from someone we haven't heard from before with the fingerprints of messages the other businesses it serves marked as spam. We don't share the fingerprints of messages we mark as spam; when one that matched turns out not to be spam, we say so, by its fingerprint. A fingerprint can't be turned back into the message.",
    spamShared:
      "To keep out spam, the provider that handles our messages compares a fingerprint of each new message from someone we haven't heard from before with the fingerprints of messages the other businesses it serves marked as spam, and shares with them the fingerprints of messages we mark as spam, or of ones that matched but weren't. A fingerprint can't be turned back into the message.",
  },
};

const PT: DisclosureCopy = {
  keySubject: "Para a próxima vez",
  // "Obrigado pela sua marcação", "pelo seu pedido": por + a, por + o.
  keyThanks: ({ what, type }) =>
    `Obrigado ${copyFor("pt")
      .yourNoun[type].replace(/^a /, "pela ")
      .replace(/^o /, "pelo ")}${what ? ` ${what}` : ""}.`,
  keyLine: "Se usar um assistente, ele pode mostrar este código da próxima vez para o reconhecermos:",
  keysLine: "Se usar um assistente, ele pode mostrar estes códigos da próxima vez para o reconhecermos:",
  networkLine: (url) => `Usamos uma rede de reservas para reconhecer clientes habituais. Como funciona: ${url}`,
  privacy: {
    title: (business) => (business ? `Clientes habituais — ${business}` : "Clientes habituais"),
    heading: "Como reconhecemos clientes habituais",
    lead: "Quando faz uma marcação ou encomenda connosco pela primeira vez e nos dá o seu email, enviamo-lo a uma rede de reservas, que cria um código para si; enviamos-lhe o código num email à parte. Se usar um assistente (uma aplicação que marca por si), ele pode mostrar o código da próxima vez para o reconhecermos.",
    which: "Que rede",
    none: "De momento não usamos nenhuma rede de reservas.",
    keepsHeading: "O que a rede guarda",
    keeps:
      "Um código para si. Não o seu email, apenas uma impressão digital dele, para saber que é a mesma pessoa quando voltar. Para cada marcação ou encomenda connosco: como terminou (por exemplo, concluída, cancelada ou falta), quando e o valor. Não recebe o seu nome, a sua morada nem as suas mensagens.",
    forHeading: "Para que serve",
    for: "Para reconhecer clientes habituais, para que os negócios da rede possam atender mais depressa os bons clientes. Nunca decide se aceitamos a sua marcação.",
    stopHeading: "Como parar",
    stop: "Não tem de usar o código: sem ele, nada muda para si aqui. Para deixarmos de usar a rede de reservas para si, use a ligação do email que lhe trouxe o código, ou responda a qualquer um dos nossos emails. A partir daí não dizemos mais nada sobre si a nenhuma rede de reservas: nenhum código, e nada sobre as suas marcações ou encomendas. As suas marcações, encomendas e os nossos emails continuam como antes.",
    askNetwork:
      "O que uma rede já tem sobre si fica com ela: ainda não lhe podemos pedir que o apague. Para perguntar, contacte a rede:",
    questionsHeading: "Dúvidas",
    questions: "Responda a qualquer um dos nossos emails.",
    stopMine:
      "O código é opcional: sem ele, nada muda para si aqui. Se parar, a partir daí não dizemos mais nada sobre si a nenhuma rede de reservas: nenhum código, e nada sobre as suas marcações ou encomendas, como terminaram ou quanto custaram. As suas marcações, encomendas e os nossos emails continuam como antes.",
    stopButton: "Deixar de a usar para mim",
    stopped: (date) =>
      `Feito. Desde ${date} não dizemos mais nada sobre si a nenhuma rede de reservas. As suas marcações, encomendas e os nossos emails continuam como antes.`,
    spamHeading: "Proteção contra spam",
    spam: "Verificamos as mensagens novas de quem ainda não nos contactou, para manter as mensagens indesejadas longe da nossa equipa. A verificação pode incluir uma leitura por um serviço automático, que vê a mensagem sem endereços de email, números de telefone ou dados bancários. Esse serviço não a usa para melhorar os seus produtos e guarda-a durante 55 dias, apenas para detetar abusos do serviço e para as comunicações que a lei exija. Alguém da nossa equipa pode ver e recuperar qualquer mensagem posta de parte enquanto for guardada.",
    spamOwn:
      "Verificamos as mensagens novas de quem ainda não nos contactou, para manter as mensagens indesejadas longe da nossa equipa. A verificação pode incluir uma leitura por um serviço automático, que vê a mensagem sem endereços de email, números de telefone ou dados bancários. Alguém da nossa equipa pode ver e recuperar qualquer mensagem posta de parte enquanto for guardada.",
    spamSharedReads:
      "Para manter o spam afastado, o fornecedor que trata as nossas mensagens compara uma impressão digital de cada mensagem nova de quem ainda não nos contactou com as impressões digitais de mensagens que as outras empresas que serve marcaram como spam. Não partilhamos as impressões digitais das mensagens que marcamos como spam; quando uma que coincidiu afinal não é spam, dizemo-lo, pela sua impressão digital. Uma impressão digital não permite reconstituir a mensagem.",
    spamShared:
      "Para manter o spam afastado, o fornecedor que trata as nossas mensagens compara uma impressão digital de cada mensagem nova de quem ainda não nos contactou com as impressões digitais de mensagens que as outras empresas que serve marcaram como spam, e partilha com elas as impressões digitais das mensagens que marcamos como spam, ou das que coincidiram mas não eram. Uma impressão digital não permite reconstituir a mensagem.",
  },
};

export const DISCLOSURE: Readonly<Record<CustomerLang, DisclosureCopy>> = { en: EN, pt: PT };

/** Where the page about the network lives on this inbox, in the customer's language. */
export function privacyUrl(base: string, lang: CustomerLang): string {
  return `${base.replace(/\/+$/, "")}/c/privacy?l=${lang}`;
}

/**
 * The email that carries a first-time customer's code: a thank-you for what they booked or ordered,
 * the code, and one line about the network with the link to the page. Nothing else rides on it, and
 * it rides on nothing else.
 */
export function keyMail(input: {
  readonly lang: CustomerLang;
  readonly name?: string | null | undefined;
  readonly business: string;
  readonly item: { readonly type: ItemType; readonly subject: string | null; readonly payload?: unknown };
  readonly keys: readonly string[];
  readonly privacyUrl: string;
}): { template: "key"; subject: string; text: string } {
  const d = DISCLOSURE[input.lang];
  const c = copyFor(input.lang);
  const lines = [
    c.email.hello(vars({ name: oneLine(input.name) })),
    "",
    d.keyThanks({ what: whatOf(input.item, input.lang), type: input.item.type }),
    input.keys.length > 1 ? d.keysLine : d.keyLine,
    ...input.keys,
    "",
    d.networkLine(input.privacyUrl),
    ...(input.business.trim() ? ["", input.business.trim()] : []),
  ];
  return { template: "key", subject: d.keySubject, text: lines.join("\n") };
}

/**
 * The page about the booking network: which networks this inbox asks for codes, what they keep,
 * what it is for, how to stop, and where to ask each network about what it keeps. The code email's
 * own link opens it for one customer (`mine`), with the button that stops it for them, or, once they
 * have, since when; `/c/privacy` shows it to anyone, and says how to stop.
 */
export function privacyPage(input: {
  readonly lang: CustomerLang;
  readonly business: string;
  /** The networks the inbox asks for a first-time customer's code (their origins). */
  readonly networks: readonly string[];
  /** For one customer, from their code email: the date they stopped it (in their words), or null while they have not. */
  readonly mine?: { readonly stopped: string | null; readonly form: CustomerPage["form"] } | undefined;
  /**
   * Whether new messages may be read by the spam filter's AI check now, and whose model (ADR-041 §14):
   * the host's, whose retention the page states, or one the business set up itself; null while none may.
   */
  readonly spamReading?: "host" | "own" | null | undefined;
  /**
   * How the inbox takes part in its host's shared list of known spam (ADR-041 §16): it compares new
   * messages (`reads`), and shares what it marks as spam too (`reads_and_shares`); null when it doesn't.
   */
  readonly spamShared?: "reads" | "reads_and_shares" | null | undefined;
}): CustomerPage {
  const d = DISCLOSURE[input.lang].privacy;
  const host = (origin: string) => {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  };
  const sections: PageSection[] = [
    {
      heading: d.which,
      paragraphs: input.networks.length ? [] : [d.none],
      links: input.networks.map((n) => ({ label: host(n), href: n })),
    },
    { heading: d.keepsHeading, paragraphs: [d.keeps] },
    { heading: d.forHeading, paragraphs: [d.for] },
    {
      heading: d.stopHeading,
      paragraphs: [
        input.mine ? (input.mine.stopped ? d.stopped(input.mine.stopped) : d.stopMine) : d.stop,
        ...(input.networks.length ? [d.askNetwork] : []),
      ],
      // The network's own address: the protocol names no privacy page a network must serve, and a
      // guessed path (`/privacy`) is a dead link on the default network.
      links: input.networks.map((n) => ({ label: host(n), href: n })),
    },
    ...(input.spamReading || input.spamShared
      ? [
          {
            heading: d.spamHeading,
            paragraphs: [
              ...(input.spamReading ? [input.spamReading === "host" ? d.spam : d.spamOwn] : []),
              ...(input.spamShared ? [input.spamShared === "reads_and_shares" ? d.spamShared : d.spamSharedReads] : []),
            ],
          },
        ]
      : []),
    { heading: d.questionsHeading, paragraphs: [d.questions] },
  ];
  return {
    status: 200,
    lang: input.lang,
    business: input.business,
    title: d.title(input.business),
    heading: d.heading,
    paragraphs: [d.lead],
    sections,
    ...(input.mine && !input.mine.stopped && input.mine.form ? { form: input.mine.form } : {}),
    footer: input.business,
    help: "",
  };
}
