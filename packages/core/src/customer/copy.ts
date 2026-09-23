import type { ItemType } from "../domain/types";
import type { CustomerLang } from "./lang";

/**
 * Every word the business says to a customer, in each language it writes: the status sentences an
 * assistant relays, the lines in an email that let the customer answer, the page a link opens and
 * the refusals a customer may hear through their assistant.
 *
 * The business speaks as "we", in its own name. Nothing here names the software, a network, an
 * offer, a key or an id: the customer wrote to the business, and a six-character reference is all
 * they need to quote back. `test/customer-copy.test.ts` walks every entry in every language.
 */
export interface CopyVars {
  /** The item's subject, in quotes, or empty. */
  readonly what: string;
  /** A time, with the zone named (`whenText`). */
  readonly when: string;
  /** The time we propose instead. */
  readonly newWhen: string;
  /** Until when the customer can answer. */
  readonly deadline: string;
  /** A total, as `moneyIn` writes it. */
  readonly total: string;
  readonly validThrough: string;
  /** The six-character reference. */
  readonly ref: string;
  /** The business's time zone, named. */
  readonly zone: string;
  /** What we asked the customer. */
  readonly question: string;
  /** A status sentence (`statusSentence`). */
  readonly status: string;
  /** The terms of what we proposed, in a sentence or two. */
  readonly summary: string;
  /** A sentence about the price, or empty. */
  readonly priceLine: string;
  /** "your booking" (lower case), as `nounPhrase` gives it. */
  readonly yourNoun: string;
  /** The business's name. */
  readonly business: string;
  /** The customer's name, when we know it; else empty. */
  readonly name: string;
  /** The time the customer asked for, beside the one we propose. */
  readonly askedWhen: string;
  /** Until when a confirmed booking can be cancelled. */
  readonly cutoff: string;
  /** An amount paid or refunded. */
  readonly amount: string;
  /** Where to pay. */
  readonly url: string;
  /** The subject of the conversation a reply answers. */
  readonly subject: string;
  /** A one-time code, and how many minutes it works for. */
  readonly code: string;
  readonly minutes: string;
}

type Say = (v: CopyVars) => string;
/** Portuguese agrees with the noun: a booking is feminine, a request masculine. */
export type Gendered = { readonly f: string; readonly m: string };
type Phrase = string | Gendered | Say | { readonly f: Say; readonly m: Say };

export interface Copy {
  /** "your booking" … at the start of a sentence, capitalised by the caller. */
  readonly yourNoun: Readonly<Record<ItemType, string>>;
  /** Grammatical gender of each noun (Portuguese); English ignores it. */
  readonly gender: Readonly<Record<ItemType, "f" | "m">>;
  readonly states: Readonly<Record<string, Phrase>>;
  /** For states whose wording depends on who closed it. */
  readonly byCustomer: Readonly<Record<"cancelled" | "declined", Phrase>>;
  /** `{Your booking} {what} for {when} {phrase}. Reference {ref}.` */
  readonly sentence: (v: CopyVars & { readonly phrase: string; readonly booking: boolean }) => string;
  readonly statedPrice: Say;
  /** `Price: €45.00.` */
  readonly price: Say;
  readonly proposed: Say;
  readonly quoted: Say;
  readonly quotedFor: Say;
  readonly obligation: Say;
  /** Before the business's last message, where an assistant reads the item's status aloud. */
  readonly lastMessage: string;
  readonly labels: Readonly<{
    accept: string;
    decline: string;
    otherTime: string;
    details: string;
    cancel: string;
    write: string;
  }>;
  readonly problems: Readonly<{
    offerChanged: Say;
    offerExpired: Say;
    noOffer: string;
    nothingToAnswer: string;
    slotTaken: string;
    timeNotFree: Say;
    notTooSoon: string;
    pastStart: string;
    notYours: string;
    notFound: string;
  }>;
  /** The lines an email carries so the customer can answer by link, or by replying without one. */
  readonly mail: Readonly<{
    accept: string;
    decline: string;
    otherTime: string;
    details: string;
    replyToAnswer: string;
    replyWithDetails: string;
  }>;
  readonly page: PageCopy;
  /** Every email the business sends a customer (`customer/mail.ts` puts them together). */
  readonly email: EmailCopy;
}

/**
 * The emails, piece by piece: `renderCustomerMail` picks the pieces for what happened and adds the
 * terms, the links and the footer. A subject gets `what` without quotes; a body with them.
 */
export interface EmailCopy {
  readonly hello: Say;
  readonly reference: Say;
  readonly replyToReach: string;
  /** Under every email a rule or the business's assistant sent (Tiago, 23 September 2026). */
  readonly automated: string;
  readonly total: Say;
  readonly priceToConfirm: string;
  /** An order line whose price is ours to set. */
  readonly lineToConfirm: string;
  readonly ack: Readonly<{
    bookingSubject: Say;
    booking: Say;
    bookingNext: string;
    orderSubject: Say;
    order: string;
    orderNext: string;
    quoteSubject: Say;
    quote: Say;
  }>;
  readonly proposed: Readonly<{ subject: Say; first: Say; youAsked: Say; answerBy: Say }>;
  readonly quoted: Readonly<{
    subject: Say;
    first: Say;
    revised: Say;
    forWhen: Say;
    holds: Say;
  }>;
  readonly details: Readonly<{ subject: Say; first: Say; orReply: string }>;
  readonly confirmed: Readonly<{ subject: Say; first: Say; proposedTime: Say; accepted: Say; cutoff: Say }>;
  readonly declined: Readonly<{ subject: Say; booking: Say; order: Say; quote: Say }>;
  readonly cancelledByUs: Readonly<{ subject: Say; booking: Say; order: Say }>;
  readonly cancelledAsAsked: Readonly<{ subject: Say; booking: Say; request: Say; order: Say }>;
  readonly declinedTime: Readonly<{ subject: Say; first: Say; next: string }>;
  readonly counter: Readonly<{ subject: Say; first: Say }>;
  readonly quoteAccepted: Readonly<{ subject: Say; booking: Say; order: Say }>;
  readonly quoteDeclined: Readonly<{ subject: Say; first: Say }>;
  readonly order: Readonly<{
    acceptedSubject: Say;
    accepted: Say;
    paymentSubject: Say;
    payment: Say;
    payHere: Say;
    paidSubject: Say;
    paid: Say;
    paidNoAmount: Say;
    failedSubject: Say;
    failed: Say;
    payStill: Say;
    fulfilledSubject: Say;
    fulfilled: Say;
  }>;
  readonly refund: Readonly<{ subject: string; approved: string; rejected: string; refunded: Say }>;
  readonly reply: Say;
  readonly answered: Say;
  readonly news: Readonly<{ subject: Say; first: Say }>;
  /** The one-time code a customer asked for, to show it is them. */
  readonly code: Readonly<{ subject: Say; subjectPlain: string; first: Say; ignore: string }>;
}

export interface PageCopy {
  readonly footer: Say;
  readonly help: string;
  readonly rows: Readonly<{
    what: string;
    when: string;
    price: string;
    total: string;
    answerBy: string;
    validUntil: string;
    note: string;
  }>;
  readonly acceptTime: Readonly<{
    heading: string;
    lead: Say;
    unheld: string;
    buttonPriced: string;
    buttonFree: string;
    notThisTime: string;
    done: Say;
    slotTaken: string;
    tooLate: string;
  }>;
  readonly declineTime: Readonly<{ heading: string; body: Say; reason: string; button: string; done: string }>;
  readonly otherTime: Readonly<{
    heading: string;
    lead: Say;
    earlier: string;
    later: string;
    noneFree: string;
    note: string;
    button: string;
    nothingChosen: string;
    done: Say;
  }>;
  readonly acceptQuote: Readonly<{
    heading: string;
    lead: Say;
    buttonPriced: string;
    buttonFree: string;
    doneBooking: Say;
    doneOrder: Say;
    expired: Say;
  }>;
  readonly declineQuote: Readonly<{ heading: string; body: Say; button: string; done: Say }>;
  readonly details: Readonly<{
    heading: string;
    lead: Say;
    label: string;
    button: string;
    empty: string;
    done: string;
  }>;
  readonly linkExpired: string;
  readonly alreadyDone: Say;
  readonly offerChanged: string;
  readonly replaced: string;
  readonly noLonger: Say;
  readonly invalid: string;
  readonly tooMany: string;
  readonly error: string;
  readonly notSent: string;
}

const EN: Copy = {
  yourNoun: {
    booking: "your booking",
    order: "your order",
    quote_request: "your request",
    message: "your message",
    refund: "your refund request",
  },
  gender: { booking: "f", order: "f", quote_request: "m", message: "f", refund: "m" },
  states: {
    requested: "is with us; we will confirm it or suggest another time",
    received: "is with us; we will get back to you soon",
    needs_info: (v) => (v.question ? `needs a detail from you: ${v.question}` : "needs a detail from you"),
    confirmed: "is confirmed",
    accepted: "is accepted",
    accepted_quote: "was accepted: thank you",
    awaiting_payment: (v) =>
      v.total ? `is accepted and waiting for your payment of ${v.total}` : "is accepted and waiting for your payment",
    payment_failed: "is accepted, but your payment did not go through",
    paid: "is paid",
    fulfilling: "is being prepared",
    fulfilled: "is completed",
    completed: "is completed",
    declined: "was declined: we cannot take it",
    expired: "has expired",
    cancelled: "was cancelled by us",
    cancelled_by_customer: "is cancelled, as you asked",
    cancelled_by_business: "was cancelled by us",
    no_show: "is recorded as missed",
    charged_back: "had its payment reversed",
    open: "is with us; we will reply soon",
    answered: "has our answer",
    closed: "is closed",
    spam: "is closed",
    approved: "is approved",
    rejected: "was not approved",
    refunded: "is refunded",
  },
  byCustomer: { cancelled: "is cancelled, as you asked", declined: "is closed, as you asked" },
  sentence: (v) =>
    `${cap(v.yourNoun)}${v.what ? ` ${v.what}` : ""}${v.booking && v.when ? ` for ${v.when}` : ""} ${stop(v.phrase)}${v.priceLine ? ` ${v.priceLine}` : ""} Reference ${v.ref}.`,
  statedPrice: (v) => `Our price is ${v.total}.`,
  price: (v) => `Price: ${v.total}.`,
  proposed: (v) =>
    `We suggest another time for your booking${v.what ? ` ${v.what}` : ""}: ${v.newWhen}.${v.priceLine ? ` ${v.priceLine}` : ""} Please answer by ${v.deadline}: accept it, decline it or pick another time. Reference ${v.ref}.`,
  quoted: (v) =>
    `Our quote for ${v.what || "your request"}: ${v.total}, valid until ${v.validThrough}.${v.when ? ` It is for ${v.when}.` : ""} Accept it or decline it. Reference ${v.ref}.`,
  quotedFor: (v) => `It is for ${v.when}.`,
  obligation: (v) => `Accepting means an obligation to pay ${v.total}.`,
  lastMessage: "Our last message to you:",
  labels: {
    accept: "Accept",
    decline: "Decline",
    otherTime: "Pick another time",
    details: "Send the details",
    cancel: "Cancel",
    write: "Write to us",
  },
  problems: {
    offerChanged: (v) => `We changed what we proposed since you read it. The current proposal: ${v.summary}`,
    offerExpired: (v) => `Our quote was valid until ${v.validThrough}. Ask us for a new one.`,
    noOffer: "There is nothing to accept on this right now.",
    nothingToAnswer: "There is nothing of ours to answer on this right now.",
    slotTaken: "That time is no longer free.",
    timeNotFree: (v) => `${v.when} is not free. Pick one of the free times.`,
    notTooSoon: "It is too close to that time to book it now.",
    pastStart: "That time has passed.",
    notYours: "This is someone else's.",
    notFound: "We cannot find this.",
  },
  mail: {
    accept: "Accept",
    decline: "Decline",
    otherTime: "Pick another time",
    details: "Send the details",
    replyToAnswer: "Reply to this email to accept, decline or ask for another time.",
    replyWithDetails: "Reply to this email with the details.",
  },
  page: {
    footer: (v) => `${v.business} · Reference ${v.ref}`,
    help: "Questions? Reply to our email.",
    rows: {
      what: "What",
      when: "When",
      price: "Price",
      total: "Total",
      answerBy: "Please answer by",
      validUntil: "Valid until",
      note: "Our note",
    },
    acceptTime: {
      heading: "Accept this time?",
      lead: (v) => `We suggested a new time for ${v.what || "your booking"}.`,
      unheld: "The time is yours if it is still free when you confirm.",
      buttonPriced: "Order with obligation to pay",
      buttonFree: "Confirm booking",
      notThisTime: "Not this time?",
      done: (v) =>
        `Your booking is confirmed — ${v.what}, ${v.when}. We have sent you a confirmation by email.`.replace(
          "— , ",
          "— ",
        ),
      slotTaken: "That time is no longer free. Sorry — someone booked it first. Pick another time:",
      tooLate: "It is too close to that time to confirm it online. Pick another time, or reply to our email.",
    },
    declineTime: {
      heading: "Decline this time?",
      body: (v) =>
        `If you decline, we will close your booking request for ${v.what || "this booking"}. Want a different time instead? Pick another time.`,
      reason: "Anything you want to tell us? (optional)",
      button: "Decline and close my request",
      done: "Your request is closed. Thank you for letting us know.",
    },
    otherTime: {
      heading: "Pick another time",
      lead: (v) => `Free times for ${v.what || "your booking"}. Times are in ${v.zone}.`,
      earlier: "Earlier",
      later: "Later",
      noneFree: "No free times on these days. See later dates, or reply to our email.",
      note: "Anything you want to tell us? (optional)",
      button: "Ask for this time",
      nothingChosen: "Choose a time first.",
      done: (v) => `We have your new time. You asked for ${v.when}. We will confirm it by email soon.`,
    },
    acceptQuote: {
      heading: "Accept our quote?",
      lead: (v) => `Our quote for ${v.what || "your request"}:`,
      buttonPriced: "Order with obligation to pay",
      buttonFree: "Accept",
      doneBooking: (v) =>
        `Your booking is confirmed — ${v.what}, ${v.when}. Total ${v.total}. We have sent you a confirmation by email.`,
      doneOrder: (v) =>
        `Thank you: your order is confirmed — ${v.what}. Total ${v.total}. We have sent you a confirmation by email.`,
      expired: (v) =>
        `This quote has expired. It was valid until ${v.validThrough}. Reply to our email and we will send you a new one.`,
    },
    declineQuote: {
      heading: "Decline our quote?",
      body: (v) => `If you decline, we will close your request for ${v.what || "this"}.`,
      button: "Decline the quote",
      done: (v) => `Thank you for letting us know. We have closed your request for ${v.what || "this"}.`,
    },
    details: {
      heading: "Send us the details",
      lead: (v) => `About ${v.yourNoun}${v.what ? ` ${v.what}` : ""}, we asked:`,
      label: "Your answer",
      button: "Send",
      empty: "Write your answer first.",
      done: "Thank you. We have your answer and will get back to you soon.",
    },
    linkExpired: "This link has expired. Reply to our email and we will help you.",
    alreadyDone: (v) => `This is already done. ${v.status}`,
    offerChanged: "We have changed what we proposed. Please use the link in our latest email.",
    replaced: "This link is from an earlier email. Please use the link in our latest email.",
    noLonger: (v) => `This can no longer be done here. ${v.status} Reply to our email if you need anything.`,
    invalid: "This link is not valid. Please check the link in our email.",
    tooMany: "Too many attempts. Please try again in a few minutes.",
    error: "Something went wrong on our side. Please try again, or reply to our email.",
    notSent: "Nothing was sent. Please use the buttons on this page.",
  },
  email: {
    hello: (v) => (v.name ? `Hello ${v.name},` : "Hello,"),
    reference: (v) => `Reference: ${v.ref}`,
    replyToReach: "Reply to this email to reach us.",
    automated: "This reply was sent automatically. Reply to reach a person.",
    total: (v) => `Total: ${v.total}`,
    priceToConfirm: "We will confirm the price with you.",
    lineToConfirm: "price to be confirmed",
    ack: {
      bookingSubject: (v) => `We have your booking request: ${v.what}`,
      booking: (v) => `Thank you. We have your request for ${v.what} on ${v.when}.`,
      bookingNext: "We will confirm it or suggest another time soon.",
      orderSubject: (v) => `We have your order: ${v.what}`,
      order: "Thank you. We have your order:",
      orderNext: "We will confirm it soon.",
      quoteSubject: (v) => `We have your request: ${v.what}`,
      quote: (v) => `Thank you. We have your request for a quote for ${v.what}. We will send you a price soon.`,
    },
    proposed: {
      subject: (v) => `Another time for ${v.what}`,
      first: (v) => `We would like to suggest another time for ${v.what}: ${v.newWhen}.`,
      youAsked: (v) => `(You asked for ${v.askedWhen}.)`,
      answerBy: (v) => `Please answer by ${v.deadline}. The time is yours if it is still free when you say yes.`,
    },
    quoted: {
      subject: (v) => `Our quote for ${v.what}`,
      first: (v) => `Here is our quote for ${v.what}:`,
      revised: (v) => `Here is our new quote for ${v.what}; it replaces the one before:`,
      forWhen: (v) => `For ${v.when}.`,
      holds: (v) => `This price holds until ${v.validThrough}.`,
    },
    details: {
      subject: (v) => `A question about ${v.yourNoun}: ${v.what}`,
      first: (v) => `We need a little more detail about ${v.yourNoun} ${v.what}:`,
      orReply: "Or simply reply to this email.",
    },
    confirmed: {
      subject: (v) => `Confirmed: ${v.what}`,
      first: (v) => `Your booking ${v.what} on ${v.when} is confirmed.`,
      proposedTime: (v) => `Your booking ${v.what} is confirmed for ${v.when}, the time we suggested.`,
      accepted: (v) => `Thank you. Your booking ${v.what} is confirmed for ${v.when}.`,
      cutoff: (v) => `If you cannot come, please tell us before ${v.cutoff}.`,
    },
    declined: {
      subject: (v) => `We cannot take ${v.what}`,
      booking: (v) => `Sorry, we cannot take your booking ${v.what} for ${v.when}.`,
      order: (v) => `Sorry, we cannot take your order ${v.what}.`,
      quote: (v) => `Sorry, we cannot take on ${v.what}.`,
    },
    cancelledByUs: {
      subject: (v) => `Cancelled: ${v.what}`,
      booking: (v) => `We are sorry: we had to cancel your booking ${v.what} on ${v.when}.`,
      order: (v) => `We are sorry: we had to cancel your order ${v.what}.`,
    },
    cancelledAsAsked: {
      subject: (v) => `Cancelled: ${v.what}`,
      booking: (v) => `Your booking ${v.what} on ${v.when} is cancelled, as you asked.`,
      request: (v) => `Your booking request ${v.what} is cancelled, as you asked.`,
      order: (v) => `Your order ${v.what} is cancelled, as you asked.`,
    },
    declinedTime: {
      subject: (v) => `Request closed: ${v.what}`,
      first: (v) =>
        `You declined the time we suggested for ${v.what}, so we have closed your request. Thank you for letting us know.`,
      next: "To book another time, just ask.",
    },
    counter: {
      subject: (v) => `We have your new time: ${v.what}`,
      first: (v) => `Thank you. You asked for ${v.when} instead. We will confirm it soon.`,
    },
    quoteAccepted: {
      subject: (v) => `Confirmed: ${v.what}`,
      booking: (v) => `Thank you for accepting our quote. Your booking ${v.what} is confirmed for ${v.when}.`,
      order: (v) => `Thank you for accepting our quote. Your order ${v.what} is confirmed.`,
    },
    quoteDeclined: {
      subject: (v) => `Declined: ${v.what}`,
      first: (v) => `You declined our quote for ${v.what}. Thank you for letting us know.`,
    },
    order: {
      acceptedSubject: (v) => `Accepted: ${v.what}`,
      accepted: (v) => `We have accepted your order ${v.what}.`,
      paymentSubject: (v) => `Payment for ${v.what}`,
      payment: (v) => `We have accepted your order ${v.what}; it is waiting for your payment of ${v.total}.`,
      payHere: (v) => `You can pay here: ${v.url}`,
      paidSubject: (v) => `Payment received: ${v.what}`,
      paid: (v) => `Thank you: we have received your payment of ${v.amount} for ${v.what}.`,
      paidNoAmount: (v) => `Thank you: we have received your payment for ${v.what}.`,
      failedSubject: (v) => `Your payment for ${v.what} did not go through`,
      failed: (v) => `Your payment for ${v.what} did not go through.`,
      payStill: (v) => `You can still pay: ${v.url}`,
      fulfilledSubject: (v) => `Completed: ${v.what}`,
      fulfilled: (v) => `We have completed your order ${v.what}.`,
    },
    refund: {
      subject: "Your refund",
      approved: "We have approved your refund request.",
      rejected: "Sorry, we cannot approve your refund request.",
      refunded: (v) => `We have refunded ${v.amount}.`,
    },
    reply: (v) => `Re: ${v.subject}`,
    answered: (v) => `We have answered your message ${v.what}.`,
    news: {
      subject: (v) => `News about ${v.what}`,
      first: (v) => `There is news about ${v.yourNoun} ${v.what}.`,
    },
    code: {
      subject: (v) => `Your code for ${v.business}`,
      subjectPlain: "Your code",
      first: (v) => `Your code is ${v.code}. It works for ${v.minutes} minutes.`,
      ignore: "If you did not ask for it, you can ignore this email.",
    },
  },
};

const PT: Copy = {
  yourNoun: {
    booking: "a sua marcação",
    order: "a sua encomenda",
    quote_request: "o seu pedido de orçamento",
    message: "a sua mensagem",
    refund: "o seu pedido de reembolso",
  },
  gender: { booking: "f", order: "f", quote_request: "m", message: "f", refund: "m" },
  states: {
    requested: {
      f: "está connosco; vamos confirmá-la ou sugerir outra hora",
      m: "está connosco; vamos confirmá-lo ou sugerir outra hora",
    },
    received: "está connosco; vamos responder em breve",
    needs_info: (v) => (v.question ? `precisa de um detalhe seu: ${v.question}` : "precisa de um detalhe seu"),
    confirmed: { f: "está confirmada", m: "está confirmado" },
    accepted: "foi aceite",
    accepted_quote: "foi aceite: obrigado",
    awaiting_payment: (v) =>
      v.total ? `foi aceite e aguarda o seu pagamento de ${v.total}` : "foi aceite e aguarda o seu pagamento",
    payment_failed: "foi aceite, mas o seu pagamento não foi concluído",
    paid: { f: "está paga", m: "está pago" },
    fulfilling: { f: "está a ser preparada", m: "está a ser preparado" },
    fulfilled: { f: "está concluída", m: "está concluído" },
    completed: { f: "está concluída", m: "está concluído" },
    declined: { f: "foi recusada: não a podemos aceitar", m: "foi recusado: não o podemos aceitar" },
    expired: "expirou",
    cancelled: { f: "foi cancelada por nós", m: "foi cancelado por nós" },
    cancelled_by_customer: { f: "foi cancelada, como pediu", m: "foi cancelado, como pediu" },
    cancelled_by_business: { f: "foi cancelada por nós", m: "foi cancelado por nós" },
    no_show: { f: "ficou registada como falta", m: "ficou registado como falta" },
    charged_back: "teve o pagamento revertido",
    open: "está connosco; vamos responder em breve",
    answered: "tem a nossa resposta",
    closed: { f: "está fechada", m: "está fechado" },
    spam: { f: "está fechada", m: "está fechado" },
    approved: { f: "foi aprovada", m: "foi aprovado" },
    rejected: { f: "não foi aprovada", m: "não foi aprovado" },
    refunded: { f: "foi reembolsada", m: "foi reembolsado" },
  },
  byCustomer: {
    cancelled: { f: "foi cancelada, como pediu", m: "foi cancelado, como pediu" },
    declined: { f: "foi fechada, como pediu", m: "foi fechado, como pediu" },
  },
  sentence: (v) =>
    `${cap(v.yourNoun)}${v.what ? ` ${v.what}` : ""}${v.booking && v.when ? ` para ${v.when}` : ""} ${stop(v.phrase)}${v.priceLine ? ` ${v.priceLine}` : ""} Referência ${v.ref}.`,
  statedPrice: (v) => `O nosso preço é ${v.total}.`,
  price: (v) => `Preço: ${v.total}.`,
  proposed: (v) =>
    `Sugerimos outra hora para a sua marcação${v.what ? ` ${v.what}` : ""}: ${v.newWhen}.${v.priceLine ? ` ${v.priceLine}` : ""} Responda até ${v.deadline}: aceite, recuse ou escolha outra hora. Referência ${v.ref}.`,
  quoted: (v) =>
    `O nosso orçamento para ${v.what || "o seu pedido"}: ${v.total}, válido até ${v.validThrough}.${v.when ? ` É para ${v.when}.` : ""} Aceite ou recuse. Referência ${v.ref}.`,
  quotedFor: (v) => `É para ${v.when}.`,
  obligation: (v) => `Aceitar implica a obrigação de pagar ${v.total}.`,
  lastMessage: "A nossa última mensagem:",
  labels: {
    accept: "Aceitar",
    decline: "Recusar",
    otherTime: "Escolher outra hora",
    details: "Enviar os detalhes",
    cancel: "Cancelar",
    write: "Escrever-nos",
  },
  problems: {
    offerChanged: (v) => `Alterámos a nossa proposta desde que a leu. A atual: ${v.summary}`,
    offerExpired: (v) => `O nosso orçamento era válido até ${v.validThrough}. Peça-nos um novo.`,
    noOffer: "Neste momento não há nada para aceitar.",
    nothingToAnswer: "Neste momento não há nada nosso a que responder.",
    slotTaken: "Essa hora já não está livre.",
    timeNotFree: (v) => `${v.when} não está livre. Escolha uma das horas livres.`,
    notTooSoon: "Já é demasiado tarde para marcar essa hora.",
    pastStart: "Essa hora já passou.",
    notYours: "Isto pertence a outra pessoa.",
    notFound: "Não encontramos isto.",
  },
  mail: {
    accept: "Aceitar",
    decline: "Recusar",
    otherTime: "Escolher outra hora",
    details: "Enviar os detalhes",
    replyToAnswer: "Responda a este email para aceitar, recusar ou pedir outra hora.",
    replyWithDetails: "Responda a este email com os detalhes.",
  },
  page: {
    footer: (v) => `${v.business} · Referência ${v.ref}`,
    help: "Dúvidas? Responda ao nosso email.",
    rows: {
      what: "O quê",
      when: "Quando",
      price: "Preço",
      total: "Total",
      answerBy: "Responda até",
      validUntil: "Válido até",
      note: "A nossa nota",
    },
    acceptTime: {
      heading: "Aceitar esta hora?",
      lead: (v) => `Sugerimos uma nova hora para ${v.what || "a sua marcação"}.`,
      unheld: "A hora fica sua se ainda estiver livre quando confirmar.",
      buttonPriced: "Encomenda com obrigação de pagar",
      buttonFree: "Confirmar marcação",
      notThisTime: "Esta hora não dá?",
      done: (v) =>
        `A sua marcação está confirmada — ${v.what}, ${v.when}. Enviámos-lhe uma confirmação por email.`.replace(
          "— , ",
          "— ",
        ),
      slotTaken: "Essa hora já não está livre. Lamentamos — já foi reservada. Escolha outra hora:",
      tooLate: "Já é demasiado tarde para confirmar esta hora online. Escolha outra hora ou responda ao nosso email.",
    },
    declineTime: {
      heading: "Recusar esta hora?",
      body: (v) =>
        `Se recusar, fechamos o seu pedido de marcação para ${v.what || "esta marcação"}. Prefere outra hora? Escolha outra hora.`,
      reason: "Quer dizer-nos alguma coisa? (opcional)",
      button: "Recusar e fechar o pedido",
      done: "O seu pedido foi fechado. Obrigado por nos avisar.",
    },
    otherTime: {
      heading: "Escolha outra hora",
      lead: (v) => `Horas livres para ${v.what || "a sua marcação"}. As horas estão em ${v.zone}.`,
      earlier: "Anteriores",
      later: "Seguintes",
      noneFree: "Não há horas livres nestes dias. Veja datas seguintes ou responda ao nosso email.",
      note: "Quer dizer-nos alguma coisa? (opcional)",
      button: "Pedir esta hora",
      nothingChosen: "Escolha primeiro uma hora.",
      done: (v) => `Recebemos a nova hora. Pediu ${v.when}. Vamos confirmar por email em breve.`,
    },
    acceptQuote: {
      heading: "Aceitar o nosso orçamento?",
      lead: (v) => `O nosso orçamento para ${v.what || "o seu pedido"}:`,
      buttonPriced: "Encomenda com obrigação de pagar",
      buttonFree: "Aceitar",
      doneBooking: (v) =>
        `A sua marcação está confirmada — ${v.what}, ${v.when}. Total ${v.total}. Enviámos-lhe uma confirmação por email.`,
      doneOrder: (v) =>
        `Obrigado: a sua encomenda está confirmada — ${v.what}. Total ${v.total}. Enviámos-lhe uma confirmação por email.`,
      expired: (v) =>
        `Este orçamento expirou. Era válido até ${v.validThrough}. Responda ao nosso email e enviamos-lhe um novo.`,
    },
    declineQuote: {
      heading: "Recusar o nosso orçamento?",
      body: (v) => `Se recusar, fechamos o seu pedido para ${v.what || "isto"}.`,
      button: "Recusar o orçamento",
      done: (v) => `Obrigado por nos avisar. Fechámos o seu pedido para ${v.what || "isto"}.`,
    },
    details: {
      heading: "Envie-nos os detalhes",
      lead: (v) => `Sobre ${v.yourNoun}${v.what ? ` ${v.what}` : ""}, perguntámos:`,
      label: "A sua resposta",
      button: "Enviar",
      empty: "Escreva primeiro a sua resposta.",
      done: "Obrigado. Recebemos a sua resposta e vamos responder em breve.",
    },
    linkExpired: "Esta ligação expirou. Responda ao nosso email e ajudamos.",
    alreadyDone: (v) => `Isto já está feito. ${v.status}`,
    offerChanged: "Alterámos a nossa proposta. Use a ligação do nosso email mais recente.",
    replaced: "Esta ligação é de um email anterior. Use a ligação do nosso email mais recente.",
    noLonger: (v) =>
      `Isto já não pode ser feito aqui. ${v.status} Responda ao nosso email se precisar de alguma coisa.`,
    invalid: "Esta ligação não é válida. Verifique a ligação no nosso email.",
    tooMany: "Demasiadas tentativas. Tente novamente dentro de alguns minutos.",
    error: "Algo correu mal do nosso lado. Tente novamente ou responda ao nosso email.",
    notSent: "Nada foi enviado. Use os botões desta página.",
  },
  email: {
    hello: (v) => (v.name ? `Olá ${v.name},` : "Olá,"),
    reference: (v) => `Referência: ${v.ref}`,
    replyToReach: "Responda a este email para falar connosco.",
    automated: "Esta resposta foi enviada automaticamente. Responda para falar com uma pessoa.",
    total: (v) => `Total: ${v.total}`,
    priceToConfirm: "Vamos confirmar o preço consigo.",
    lineToConfirm: "preço a confirmar",
    ack: {
      bookingSubject: (v) => `Recebemos o seu pedido de marcação: ${v.what}`,
      booking: (v) => `Obrigado. Recebemos o seu pedido de ${v.what} para ${v.when}.`,
      bookingNext: "Vamos confirmar ou sugerir outra hora em breve.",
      orderSubject: (v) => `Recebemos a sua encomenda: ${v.what}`,
      order: "Obrigado. Recebemos a sua encomenda:",
      orderNext: "Vamos confirmá-la em breve.",
      quoteSubject: (v) => `Recebemos o seu pedido: ${v.what}`,
      quote: (v) => `Obrigado. Recebemos o seu pedido de orçamento para ${v.what}. Vamos enviar-lhe um preço em breve.`,
    },
    proposed: {
      subject: (v) => `Outra hora para ${v.what}`,
      first: (v) => `Queremos sugerir outra hora para ${v.what}: ${v.newWhen}.`,
      youAsked: (v) => `(Pediu ${v.askedWhen}.)`,
      answerBy: (v) => `Responda até ${v.deadline}. A hora fica sua se ainda estiver livre quando disser que sim.`,
    },
    quoted: {
      subject: (v) => `O nosso orçamento para ${v.what}`,
      first: (v) => `Aqui está o nosso orçamento para ${v.what}:`,
      revised: (v) => `Aqui está o nosso novo orçamento para ${v.what}; substitui o anterior:`,
      forWhen: (v) => `Para ${v.when}.`,
      holds: (v) => `Este preço é válido até ${v.validThrough}.`,
    },
    details: {
      subject: (v) => `Uma pergunta sobre ${v.yourNoun}: ${v.what}`,
      first: (v) => `Precisamos de mais um detalhe sobre ${v.yourNoun} ${v.what}:`,
      orReply: "Ou responda simplesmente a este email.",
    },
    confirmed: {
      subject: (v) => `Confirmado: ${v.what}`,
      first: (v) => `A sua marcação ${v.what} para ${v.when} está confirmada.`,
      proposedTime: (v) => `A sua marcação ${v.what} está confirmada para ${v.when}, a hora que sugerimos.`,
      accepted: (v) => `Obrigado. A sua marcação ${v.what} está confirmada para ${v.when}.`,
      cutoff: (v) => `Se não puder vir, avise-nos antes de ${v.cutoff}.`,
    },
    declined: {
      subject: (v) => `Não podemos aceitar ${v.what}`,
      booking: (v) => `Lamentamos, mas não podemos aceitar a sua marcação ${v.what} para ${v.when}.`,
      order: (v) => `Lamentamos, mas não podemos aceitar a sua encomenda ${v.what}.`,
      quote: (v) => `Lamentamos, mas não podemos fazer ${v.what}.`,
    },
    cancelledByUs: {
      subject: (v) => `Cancelado: ${v.what}`,
      booking: (v) => `Lamentamos: tivemos de cancelar a sua marcação ${v.what} de ${v.when}.`,
      order: (v) => `Lamentamos: tivemos de cancelar a sua encomenda ${v.what}.`,
    },
    cancelledAsAsked: {
      subject: (v) => `Cancelado: ${v.what}`,
      booking: (v) => `A sua marcação ${v.what} de ${v.when} foi cancelada, como pediu.`,
      request: (v) => `O seu pedido de marcação ${v.what} foi cancelado, como pediu.`,
      order: (v) => `A sua encomenda ${v.what} foi cancelada, como pediu.`,
    },
    declinedTime: {
      subject: (v) => `Pedido fechado: ${v.what}`,
      first: (v) =>
        `Recusou a hora que sugerimos para ${v.what}, por isso fechámos o seu pedido. Obrigado por nos avisar.`,
      next: "Para marcar outra hora, basta pedir.",
    },
    counter: {
      subject: (v) => `Recebemos a nova hora: ${v.what}`,
      first: (v) => `Obrigado. Pediu ${v.when} em alternativa. Vamos confirmar em breve.`,
    },
    quoteAccepted: {
      subject: (v) => `Confirmado: ${v.what}`,
      booking: (v) =>
        `Obrigado por aceitar o nosso orçamento. A sua marcação ${v.what} está confirmada para ${v.when}.`,
      order: (v) => `Obrigado por aceitar o nosso orçamento. A sua encomenda ${v.what} está confirmada.`,
    },
    quoteDeclined: {
      subject: (v) => `Recusado: ${v.what}`,
      first: (v) => `Recusou o nosso orçamento para ${v.what}. Obrigado por nos avisar.`,
    },
    order: {
      acceptedSubject: (v) => `Aceite: ${v.what}`,
      accepted: (v) => `Aceitámos a sua encomenda ${v.what}.`,
      paymentSubject: (v) => `Pagamento de ${v.what}`,
      payment: (v) => `Aceitámos a sua encomenda ${v.what}; aguarda o seu pagamento de ${v.total}.`,
      payHere: (v) => `Pode pagar aqui: ${v.url}`,
      paidSubject: (v) => `Pagamento recebido: ${v.what}`,
      paid: (v) => `Obrigado: recebemos o seu pagamento de ${v.amount} para ${v.what}.`,
      paidNoAmount: (v) => `Obrigado: recebemos o seu pagamento para ${v.what}.`,
      failedSubject: (v) => `O seu pagamento de ${v.what} não foi concluído`,
      failed: (v) => `O seu pagamento de ${v.what} não foi concluído.`,
      payStill: (v) => `Ainda pode pagar: ${v.url}`,
      fulfilledSubject: (v) => `Concluída: ${v.what}`,
      fulfilled: (v) => `Concluímos a sua encomenda ${v.what}.`,
    },
    refund: {
      subject: "O seu reembolso",
      approved: "Aprovámos o seu pedido de reembolso.",
      rejected: "Lamentamos, mas não podemos aprovar o seu pedido de reembolso.",
      refunded: (v) => `Fizemos o reembolso de ${v.amount}.`,
    },
    reply: (v) => `Re: ${v.subject}`,
    answered: (v) => `Respondemos à sua mensagem ${v.what}.`,
    news: {
      subject: (v) => `Novidades sobre ${v.what}`,
      first: (v) => `Há novidades sobre ${v.yourNoun} ${v.what}.`,
    },
    code: {
      subject: (v) => `O seu código para ${v.business}`,
      subjectPlain: "O seu código",
      first: (v) => `O seu código é ${v.code}. É válido durante ${v.minutes} minutos.`,
      ignore: "Se não o pediu, pode ignorar este email.",
    },
  },
};

export const COPY: Readonly<Record<CustomerLang, Copy>> = { en: EN, pt: PT };

export function copyFor(lang: CustomerLang): Copy {
  return COPY[lang];
}

/** A phrase in the noun's gender, with the variables filled in. */
export function phraseOf(phrase: Phrase | undefined, gender: "f" | "m", v: CopyVars): string {
  if (phrase === undefined) return "";
  if (typeof phrase === "string") return phrase;
  if (typeof phrase === "function") return phrase(v);
  const pick = phrase[gender];
  return typeof pick === "function" ? pick(v) : pick;
}

/** Variables with every field empty, for a caller to fill the ones it has. */
export function vars(partial: Partial<CopyVars>): CopyVars {
  return {
    what: "",
    when: "",
    newWhen: "",
    deadline: "",
    total: "",
    validThrough: "",
    ref: "",
    zone: "",
    question: "",
    status: "",
    summary: "",
    priceLine: "",
    yourNoun: "",
    business: "",
    name: "",
    askedWhen: "",
    cutoff: "",
    amount: "",
    url: "",
    subject: "",
    code: "",
    minutes: "",
    ...partial,
  };
}

/** Ends a sentence once: a question the business asked keeps its own mark. */
function stop(text: string): string {
  return /[.?!…]$/.test(text) ? text : `${text}.`;
}

export function cap(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

/**
 * What the business tells a customer's assistant before an acceptance binds them (the confirm
 * step): addressed to the assistant, so in English, with the fingerprint it must send back.
 */
export function confirmTermsMessage(summary: string, sha: string): string {
  return `Before this binds your customer, show them: ${summary} Accept only on their clear yes, with terms_sha ${sha}.`;
}
