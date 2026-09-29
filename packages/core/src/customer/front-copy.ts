import type { CustomerLang } from "./lang";

/**
 * The words of the business's own page (the web form door, ADR-010): what a visitor reads at the
 * inbox's address, in the business's name and the visitor's language. Never the software's name.
 */
export interface FrontCopy {
  /** The page's heading, under the business's name. */
  readonly heading: string;
  /** Above the list of services that can be booked. */
  readonly bookHeading: string;
  /** A service in the list: its name, then how long and what it costs, when known. */
  readonly serviceLine: (v: { readonly name: string; readonly facts: string }) => string;
  readonly minutes: (n: number) => string;
  /** A price that starts at this amount. */
  readonly from: (price: string) => string;
  readonly onRequest: string;
  /** A fixed price of nothing. */
  readonly free: string;
  readonly quoteLink: string;
  readonly messageLink: string;
  /** Before the quote and message links when there are services too. */
  readonly or: string;
  readonly book: {
    readonly heading: (service: string) => string;
    readonly lead: string;
    /** Which clock the free times are on: `Western European Time`. */
    readonly zone: (zone: string) => string;
    readonly duration: string;
    readonly price: string;
    readonly noService: string;
    readonly timeTaken: string;
    readonly pickTime: string;
    readonly confirmHeading: string;
  };
  readonly quote: { readonly heading: string; readonly lead: string; readonly what: string };
  readonly message: { readonly heading: string; readonly lead: string; readonly what: string };
  readonly fields: { readonly name: string; readonly email: string; readonly note: string };
  readonly send: string;
  readonly missing: string;
  readonly badEmail: string;
  readonly sent: {
    readonly heading: string;
    readonly booking: string;
    readonly quote: string;
    readonly message: string;
  };
  readonly back: string;
  /** For the business's own people: the way to their inbox. */
  readonly signIn: string;
  readonly tooMany: string;
}

const EN: FrontCopy = {
  heading: "How can we help?",
  bookHeading: "Book a time",
  serviceLine: (v) => (v.facts ? `${v.name} · ${v.facts}` : v.name),
  minutes: (n) => (n % 60 === 0 ? `${n / 60} h` : n > 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`),
  from: (price) => `from ${price}`,
  onRequest: "price on request",
  free: "free",
  quoteLink: "Ask for a quote",
  messageLink: "Send us a message",
  or: "Or:",
  book: {
    heading: (service) => `Book: ${service}`,
    lead: "Pick a time, then tell us who you are. We'll confirm by email.",
    zone: (zone) => `Times are in ${zone}.`,
    duration: "How long",
    price: "Price",
    noService: "We don't offer that service any more.",
    timeTaken: "That time is no longer free. Pick another one:",
    pickTime: "Please pick a time.",
    confirmHeading: "Check and confirm",
  },
  quote: {
    heading: "Ask for a quote",
    lead: "Tell us what you need. We'll reply with a price by email.",
    what: "What do you need?",
  },
  message: {
    heading: "Send us a message",
    lead: "We'll reply by email.",
    what: "Your message",
  },
  fields: { name: "Your name", email: "Your email", note: "Anything we should know? (optional)" },
  send: "Send",
  missing: "Please fill in your name, your email and the rest of the form.",
  badEmail: "That email address doesn't look right.",
  sent: {
    heading: "Thank you",
    booking: "We have your booking request. We'll email you as soon as it's confirmed.",
    quote: "We have your request. We'll email you a quote.",
    message: "We have your message. We'll reply by email.",
  },
  back: "Back",
  signIn: "Staff sign in",
  tooMany: "Too many requests from here just now. Please try again in a little while.",
};

const PT: FrontCopy = {
  heading: "Em que podemos ajudar?",
  bookHeading: "Marcar",
  serviceLine: (v) => (v.facts ? `${v.name} · ${v.facts}` : v.name),
  minutes: (n) => (n % 60 === 0 ? `${n / 60} h` : n > 60 ? `${Math.floor(n / 60)} h ${n % 60} min` : `${n} min`),
  from: (price) => `desde ${price}`,
  onRequest: "preço sob consulta",
  free: "grátis",
  quoteLink: "Pedir um orçamento",
  messageLink: "Enviar uma mensagem",
  or: "Ou:",
  book: {
    heading: (service) => `Marcar: ${service}`,
    lead: "Escolha uma hora e diga-nos quem é. Confirmamos por e-mail.",
    zone: (zone) => `As horas estão em ${zone}.`,
    duration: "Duração",
    price: "Preço",
    noService: "Já não oferecemos esse serviço.",
    timeTaken: "Essa hora já não está livre. Escolha outra:",
    pickTime: "Escolha uma hora, por favor.",
    confirmHeading: "Verifique e confirme",
  },
  quote: {
    heading: "Pedir um orçamento",
    lead: "Diga-nos do que precisa. Respondemos com um preço por e-mail.",
    what: "Do que precisa?",
  },
  message: {
    heading: "Enviar uma mensagem",
    lead: "Respondemos por e-mail.",
    what: "A sua mensagem",
  },
  fields: { name: "O seu nome", email: "O seu e-mail", note: "Algo que devamos saber? (opcional)" },
  send: "Enviar",
  missing: "Preencha o seu nome, o seu e-mail e o resto do formulário, por favor.",
  badEmail: "Esse endereço de e-mail não parece estar certo.",
  sent: {
    heading: "Obrigado",
    booking: "Recebemos o seu pedido de marcação. Enviamos um e-mail assim que estiver confirmada.",
    quote: "Recebemos o seu pedido. Enviamos-lhe um orçamento por e-mail.",
    message: "Recebemos a sua mensagem. Respondemos por e-mail.",
  },
  back: "Voltar",
  signIn: "Entrada da equipa",
  tooMany: "Demasiados pedidos a partir daqui neste momento. Tente de novo daqui a pouco.",
};

export const FRONT_COPY: Readonly<Record<CustomerLang, FrontCopy>> = { en: EN, pt: PT };

export function frontCopy(lang: CustomerLang): FrontCopy {
  return FRONT_COPY[lang];
}
