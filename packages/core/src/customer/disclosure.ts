import type { ItemType } from "../domain/types";
import { copyFor, vars } from "./copy";
import { whatOf } from "./describe";
import { oneLine } from "./format";
import type { CustomerLang } from "./lang";
import type { CustomerPage, PageSection } from "./page";

/**
 * The two places the business tells a customer about the booking network it uses (ADR-017 §2.1, as
 * Tiago decided on 23 September 2026): the short email that carries a first-time customer's code,
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
