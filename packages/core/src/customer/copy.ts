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
  /** A number of days (the withdrawal period), or of hours (how soon we answer a return). */
  readonly days: string;
  readonly hours: string;
  /** Where to send things back, or the trader's address. */
  readonly address: string;
  /** The payment a refund went back by. */
  readonly paymentRef: string;
  /** The list price beside a price chosen for this customer (the personalised-price notice). */
  readonly listPrice: string;
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
  /**
   * The personalised-price notice (CRD art. 6(1)(ea)), beside every price the inbox chose for this
   * customer — the owner's reward for their record, a discount automation gave, their own price taken:
   * `total` is theirs, `listPrice` ours.
   */
  readonly personalised: Say;
  /** `Price: €45.00.` */
  readonly price: Say;
  readonly proposed: Say;
  /** The changes we suggest to an order, in one sentence: `summary` holds the lines. */
  readonly proposedOrder: Say;
  /** A change we ask for to a confirmed booking, in one sentence: from `when` to `newWhen`. */
  readonly changeAsked: Say;
  /** A change we ask for to an accepted order: `summary` holds its lines as they would be. */
  readonly changeAskedOrder: Say;
  /** After the status of a promise the customer asked to change, while we have not answered. */
  readonly changeRequested: Readonly<{ time: Say; order: string }>;
  readonly quoted: Say;
  readonly quotedFor: Say;
  readonly obligation: Say;
  /** What we proposed "subject to our confirmation" (`negotiation.binding` off) says so. */
  readonly withdrawable: string;
  /** Before the business's last message, where an assistant reads the item's status aloud. */
  readonly lastMessage: string;
  readonly labels: Readonly<{
    accept: string;
    decline: string;
    otherTime: string;
    details: string;
    cancel: string;
    write: string;
    suggestChange: string;
    /** A change to a promise. */
    acceptChange: string;
    keepAsIs: string;
    changeTime: string;
    withdrawChange: string;
  }>;
  readonly problems: Readonly<{
    offerChanged: Say;
    offerExpired: Say;
    /** A time we proposed, past the date to accept it. */
    timeLapsed: Say;
    /** Changes we suggested to an order, past the date to accept them. */
    changesLapsed: Say;
    /** A suggestion that goes to a person (a price, or past the last round): never refused. */
    passedOn: Say;
    noOffer: string;
    nothingToAnswer: string;
    slotTaken: string;
    timeNotFree: Say;
    notTooSoon: string;
    pastStart: string;
    notYours: string;
    notFound: string;
    /** Nothing of the other side's to say yes or no to on a promise. */
    noChange: string;
    /** A change we asked for, past the date to accept it. */
    changeLapsed: Say;
    /** A change the promise can no longer take by asking: a person answers it. */
    changesExhausted: string;
    /** A change that cannot be made online just now: a person answers it. */
    changeByPerson: string;
    /** A change that is what was agreed already. */
    sameAsAgreed: string;
    /** A change taken for a person to answer: never refused, and the promise stands as agreed. */
    changePassedOn: Say;
  }>;
  /** The lines an email carries so the customer can answer by link, or by replying without one. */
  readonly mail: Readonly<{
    accept: string;
    decline: string;
    otherTime: string;
    details: string;
    replyToAnswer: string;
    /** Changes we suggested to an order, answered by replying. */
    replyToAnswerOrder: string;
    replyWithDetails: string;
    acceptChange: string;
    keepAsIs: string;
    changeTime: string;
    /** A change we asked for to a promise, answered by replying. */
    replyToAnswerChange: string;
  }>;
  readonly page: PageCopy;
  /** Every email the business sends a customer (`customer/mail.ts` puts them together). */
  readonly email: EmailCopy;
  /** The right of withdrawal (ADR-018 §7), in the words of the EU law; the UK's are `WITHDRAWAL_UK`. */
  readonly withdrawal: WithdrawalCopy;
  /** A return or a refund, as the customer reads it (ADR-018 §3.4). */
  readonly returns: ReturnCopy;
  /**
   * The confirm step before a priced request binds the customer (ADR-018 §5; CRD art. 8(2)): what they
   * are about to order, from whom, and that confirming means paying.
   */
  readonly confirmStep: Readonly<{ booking: Say; order: Say; trader: Say; obligation: Say }>;
}

/** The exceptions to the right of withdrawal, as the customer is told before they order. */
export type ExceptionWords = Readonly<
  Record<
    | "personalised"
    | "perishable"
    | "sealed_hygiene"
    | "sealed_media"
    | "mixed"
    | "dated_leisure"
    | "urgent_repair"
    | "digital_started"
    | "price_fluctuates",
    string
  >
>;

/**
 * The right of withdrawal, word by word (ADR-018 §5, §7): the link and its button (CRD art. 11a),
 * the line before an order, the acknowledgement, the model form, and the page.
 */
export interface WithdrawalCopy {
  /** The link in every confirmation, and the answer an assistant offers: "Withdraw from contract here". */
  readonly label: string;
  /** The button that sends it: "Confirm withdrawal". */
  readonly confirm: string;
  /** Before an order: `days` from receiving it. */
  readonly lineGoods: Say;
  /** Before a booking: `days` from booking. */
  readonly lineService: Say;
  /** A service that starts within the period: the customer asks for it to start then. */
  readonly startsEarly: string;
  /** Until when, once the period has begun. */
  readonly until: Say;
  /** Why this one cannot be withdrawn from. */
  readonly except: ExceptionWords;
  readonly receivedSubject: Say;
  /** `when`: when they withdrew. */
  readonly received: Say;
  /** What they sent us, word for word (the statement). */
  readonly statement: Say;
  readonly refundBy: Say;
  readonly sendBack: Say;
  readonly sendBackTo: Say;
  readonly refundOnReturn: Say;
  readonly postageCustomer: string;
  readonly postageUs: string;
  /** The model form (Annex I(B)), with our name, address and email in it. */
  readonly modelForm: Say;
  /** Before a VAT number, in the line that says who we are. */
  readonly vatLabel: string;
  /** Our answer when it can no longer be done online: passed to a person. */
  readonly passedOn: Say;
  /** Why not, when the period has ended or there is no right (not excepted): `yourNoun`. */
  readonly noRight: Say;
  readonly page: Readonly<{
    heading: string;
    lead: string;
    name: string;
    contract: string;
    email: string;
    note: string;
    done: Say;
    /** Nothing to withdraw from any more (the period ended, or it is excepted): it still reaches a person. */
    stillSend: string;
  }>;
}

/** A return or a refund: where it stands, and the emails about it. */
export interface ReturnCopy {
  readonly status: Readonly<{
    requested: Say;
    approvedBack: Say;
    approvedRefund: Say;
    goodsReceived: Say;
    disputed: Say;
    refunded: Say;
    rejected: Say;
    cancelled: Say;
  }>;
  readonly subject: Say;
  readonly received: Say;
  readonly faulty: Say;
  readonly approvedBack: Say;
  readonly approvedRefund: Say;
  readonly method: Readonly<{ post: string; drop_off: string; collection: string }>;
  readonly goodsBack: Say;
  readonly goodsBackLater: Say;
  readonly refunded: Say;
  readonly rejected: Say;
  readonly disagree: string;
  readonly complaints: Say;
  readonly disputed: Say;
  readonly disputedNext: string;
  readonly cancelled: Say;
  /** Under an order we cancelled after it was paid. */
  readonly cancelledPaid: Say;
  /** Under an order the customer asked us to cancel after they paid. */
  readonly refundToAsk: Say;
  readonly labels: Readonly<{ sendBack: string; cancel: string }>;
  readonly problems: Readonly<{
    /** Another return of the order is open: add to it. */
    returnOpen: Say;
    /** It can no longer be withdrawn from online. */
    noWithdrawal: Say;
    /** A return is for goods that reached the customer. */
    nothingToReturn: string;
    /** What they named has come back already, and been refunded: nothing more of it to return. */
    alreadyBack: string;
    /** A refund with nothing to send back: nothing to keep by dropping it. */
    nothingToKeep: string;
    /** Nothing agreed yet to withdraw from: a request is simply cancelled. */
    notAgreed: string;
  }>;
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
  readonly proposed: Readonly<{
    subject: Say;
    first: Say;
    /** Another time replaces the one we suggested before. */
    revised: Say;
    youAsked: Say;
    answerBy: Say;
    /** …and we keep the time for them until then. */
    answerByHeld: Say;
  }>;
  /** Changes we suggest to an order. */
  readonly orderProposed: Readonly<{ subject: Say; first: Say; revised: Say; answerBy: Say }>;
  /** We withdrew what we proposed; the request stays with us. */
  readonly retracted: Readonly<{ subject: Say; time: Say; order: Say; quote: Say }>;
  /** It lapsed: what we proposed, or a request nobody answered in time. */
  readonly expired: Readonly<{
    subject: Say;
    time: Say;
    quote: Say;
    order: Say;
    /** We did not answer the customer's request in time. */
    unanswered: Say;
    /** The customer did not answer what we asked. */
    waitingOnYou: Say;
  }>;
  /** The customer's answer to changes we suggested, or to a quote, received. */
  readonly counterReceived: Readonly<{ subject: Say; order: Say; quote: Say }>;
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
  /** A change to a promise: asked for by us, received from the customer, made, or not made. */
  readonly change: Readonly<{
    askTimeSubject: Say;
    askOrderSubject: Say;
    askTime: Say;
    askOrder: Say;
    answerBy: Say;
    answerByHeld: Say;
    receivedSubject: Say;
    receivedTime: Say;
    receivedOrder: Say;
    doneSubject: Say;
    doneTime: Say;
    doneOrder: Say;
    keptSubject: Say;
    /** We cannot take the customer's change. */
    weCantTime: Say;
    weCantOrder: Say;
    /** The customer said no to ours, or took back theirs. */
    keptTime: Say;
    keptOrder: Say;
    /** We took back ours. */
    withdrawnTime: Say;
    withdrawnOrder: Say;
    /** Ours lapsed unanswered. */
    lapsedOursTime: Say;
    lapsedOursOrder: Say;
    /** Theirs lapsed: we did not answer in time. */
    lapsedYoursTime: Say;
    lapsedYoursOrder: Say;
    newTotal: Say;
  }>;
  readonly declinedTime: Readonly<{ subject: Say; first: Say; next: string }>;
  readonly counter: Readonly<{ subject: Say; first: Say }>;
  readonly quoteAccepted: Readonly<{ subject: Say; booking: Say; order: Say }>;
  readonly quoteDeclined: Readonly<{ subject: Say; first: Say }>;
  readonly order: Readonly<{
    acceptedSubject: Say;
    accepted: Say;
    /** The customer accepted the changes we suggested. */
    acceptedChanges: Say;
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
    delivery: string;
    /** A change: the promise as it stands, and what it would be instead. */
    now: string;
    instead: string;
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
    /** Past the date to accept it. */
    lapsed: Say;
    /** We keep the time for them while they answer. */
    held: string;
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
  readonly acceptOrder: Readonly<{
    heading: string;
    lead: Say;
    buttonPriced: string;
    buttonFree: string;
    done: Say;
    lapsed: Say;
  }>;
  readonly declineOrder: Readonly<{ heading: string; body: Say; button: string; done: string }>;
  /** A change we asked for to a promise. */
  readonly acceptChange: Readonly<{
    heading: string;
    lead: Say;
    buttonPriced: string;
    buttonFree: string;
    doneTime: Say;
    doneOrder: Say;
    lapsed: Say;
  }>;
  readonly keepAsIs: Readonly<{ heading: string; body: Say; button: string; done: Say }>;
  /** The customer asks to move their confirmed booking. */
  readonly changeTime: Readonly<{ heading: string; lead: Say; button: string; done: Say }>;
  /** A suggestion taken for a person to answer. */
  readonly passedOn: Say;
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
    refund: "your return",
  },
  gender: { booking: "f", order: "f", quote_request: "m", message: "f", refund: "f" },
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
    goods_received: "is back with us",
    rejected: "was not approved",
    refunded: "is refunded",
  },
  byCustomer: { cancelled: "is cancelled, as you asked", declined: "is closed, as you asked" },
  sentence: (v) =>
    `${cap(v.yourNoun)}${v.what ? ` ${v.what}` : ""}${v.booking && v.when ? ` for ${v.when}` : ""} ${stop(v.phrase)}${v.priceLine ? ` ${v.priceLine}` : ""} Reference ${v.ref}.`,
  statedPrice: (v) => `Our price is ${v.total}.`,
  personalised: (v) =>
    `Your price: ${v.total} (our price ${v.listPrice}). We personalised this price for you by automated decision-making.`,
  price: (v) => `Price: ${v.total}.`,
  proposed: (v) =>
    `We suggest another time for your booking${v.what ? ` ${v.what}` : ""}: ${v.newWhen}.${v.priceLine ? ` ${v.priceLine}` : ""} Please answer by ${v.deadline}: accept it, decline it or pick another time. Reference ${v.ref}.`,
  proposedOrder: (v) =>
    `We suggest some changes to your order${v.what ? ` ${v.what}` : ""}: ${v.summary}. Total ${v.total}. Please answer by ${v.deadline}: accept them, decline them, or tell us what you would change. Reference ${v.ref}.`,
  changeAsked: (v) =>
    `We would like to move your booking${v.what ? ` ${v.what}` : ""} from ${v.when} to ${v.newWhen}.${v.priceLine ? ` ${v.priceLine}` : ""} Please answer by ${v.deadline}: accept the change, or keep your booking as it is. Reference ${v.ref}.`,
  changeAskedOrder: (v) =>
    `We would like to change your order${v.what ? ` ${v.what}` : ""} to: ${v.summary}. Total ${v.total}. Please answer by ${v.deadline}: accept the change, or keep your order as it is. Reference ${v.ref}.`,
  changeRequested: {
    time: (v) => `You asked to move it to ${v.newWhen}; until we answer, it stays as it is.`,
    order: "You asked for changes to it; until we answer, it stays as it is.",
  },
  quoted: (v) =>
    `Our quote for ${v.what || "your request"}: ${v.total}, valid until ${v.validThrough}.${v.when ? ` It is for ${v.when}.` : ""} Accept it or decline it. Reference ${v.ref}.`,
  quotedFor: (v) => `It is for ${v.when}.`,
  obligation: (v) => `Accepting means an obligation to pay ${v.total}.`,
  withdrawable: "Until you accept, we may still withdraw what we proposed.",
  lastMessage: "Our last message to you:",
  labels: {
    accept: "Accept",
    decline: "Decline",
    otherTime: "Pick another time",
    details: "Send the details",
    cancel: "Cancel",
    write: "Write to us",
    suggestChange: "Suggest a change",
    acceptChange: "Accept the change",
    keepAsIs: "Keep it as it is",
    changeTime: "Change the time",
    withdrawChange: "Withdraw my request",
  },
  problems: {
    offerChanged: (v) => `We changed what we proposed since you read it. The current proposal: ${v.summary}`,
    offerExpired: (v) => `Our quote was valid until ${v.validThrough}. Ask us for a new one.`,
    timeLapsed: (v) =>
      `The time we suggested could be accepted until ${v.deadline}. Pick another time, or write to us.`,
    changesLapsed: (v) =>
      `The changes we suggested could be accepted until ${v.deadline}. Write to us and we will look at your order again.`,
    passedOn: (v) =>
      `We have passed this on to a person on our team, who will reply soon.${v.deadline ? ` What we proposed still stands until ${v.deadline}.` : ""}`,
    noOffer: "There is nothing to accept on this right now.",
    nothingToAnswer: "There is nothing of ours to answer on this right now.",
    slotTaken: "That time is no longer free.",
    timeNotFree: (v) => `${v.when} is not free. Pick one of the free times.`,
    notTooSoon: "It is too close to that time to book it now.",
    pastStart: "That time has passed.",
    notYours: "This is someone else's.",
    notFound: "We cannot find this.",
    noChange: "There is no change to answer on this right now.",
    changeLapsed: (v) => `The change we suggested could be accepted until ${v.deadline}; what we agreed stands.`,
    changesExhausted: "A person on our team will answer this change. What we agreed stands until then.",
    changeByPerson:
      "We cannot make this change online just now; a person on our team will help. What we agreed stands.",
    sameAsAgreed: "That is what we agreed already.",
    changePassedOn: (v) =>
      `We have passed your request on to a person on our team, who will reply soon. ${cap(v.yourNoun)} stays as agreed${v.when ? `, for ${v.when}` : ""}.`,
  },
  mail: {
    accept: "Accept",
    decline: "Decline",
    otherTime: "Pick another time",
    details: "Send the details",
    replyToAnswer: "Reply to this email to accept, decline or ask for another time.",
    replyToAnswerOrder: "Reply to this email to accept or decline, or to tell us what you would change.",
    replyWithDetails: "Reply to this email with the details.",
    acceptChange: "Accept the change",
    keepAsIs: "Keep it as it is",
    changeTime: "Change the time",
    replyToAnswerChange: "Reply to this email to accept the change, or to keep things as they are.",
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
      delivery: "Delivery",
      now: "Now",
      instead: "Instead",
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
      lapsed: (v) =>
        `The time we suggested could be accepted until ${v.deadline}. Pick another time, or reply to our email.`,
      held: "We are keeping this time for you until you answer.",
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
    acceptOrder: {
      heading: "Accept our changes?",
      lead: (v) => `Your order${v.what ? ` ${v.what}` : ""}, with the changes we suggest:`,
      buttonPriced: "Order with obligation to pay",
      buttonFree: "Confirm order",
      done: (v) =>
        `Thank you: your order ${v.what} is confirmed. Total ${v.total}. We have sent you a confirmation by email.`,
      lapsed: (v) =>
        `The changes we suggested could be accepted until ${v.deadline}. Reply to our email and we will look at your order again.`,
    },
    declineOrder: {
      heading: "Decline our changes?",
      body: (v) =>
        `If you decline, we will close your order${v.what ? ` ${v.what}` : ""}. Would something else suit you? Reply to our email and tell us.`,
      button: "Decline and close my order",
      done: "Your order is closed. Thank you for letting us know.",
    },
    acceptChange: {
      heading: "Accept this change?",
      lead: (v) =>
        `We would like to change ${v.yourNoun}${v.what ? ` ${v.what}` : ""}. If it does not suit you, it stays as it is.`,
      buttonPriced: "Order with obligation to pay",
      buttonFree: "Confirm the change",
      doneTime: (v) =>
        `Done: ${v.yourNoun}${v.what ? ` ${v.what}` : ""} is now for ${v.when}. We have sent you a confirmation by email.`,
      doneOrder: (v) =>
        `Done: your order${v.what ? ` ${v.what}` : ""} is changed. Total ${v.total}. We have sent you a confirmation by email.`,
      lapsed: (v) => `The change we suggested could be accepted until ${v.deadline}; ${v.yourNoun} stays as it is.`,
    },
    keepAsIs: {
      heading: "Keep it as it is?",
      body: (v) =>
        `We will keep ${v.yourNoun}${v.what ? ` ${v.what}` : ""}${v.when ? ` for ${v.when}` : ""}, as agreed.`,
      button: "Keep it as it is",
      done: (v) => `${cap(v.yourNoun)}${v.what ? ` ${v.what}` : ""} stays as it is. Thank you for letting us know.`,
    },
    changeTime: {
      heading: "Change the time",
      lead: (v) =>
        `Free times for ${v.what || "your booking"}. Until we confirm the new time, your booking stays for ${v.when}. Times are in ${v.zone}.`,
      button: "Ask for this time",
      done: (v) =>
        `We have your request to move ${v.what || "your booking"} to ${v.newWhen}. Until we confirm, your booking stays for ${v.when}.`,
    },
    passedOn: (v) =>
      `Thank you. We have passed this on to a person on our team, who will reply soon.${v.deadline ? ` What we proposed still stands until ${v.deadline}.` : ""}`,
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
      revised: (v) => `We have changed the time we suggested for ${v.what}: it is now ${v.newWhen}.`,
      youAsked: (v) => `(You asked for ${v.askedWhen}.)`,
      answerBy: (v) => `Please answer by ${v.deadline}. The time is yours if it is still free when you say yes.`,
      answerByHeld: (v) => `Please answer by ${v.deadline}. We are keeping the time for you until then.`,
    },
    orderProposed: {
      subject: (v) => `About your order ${v.what}: please check our changes`,
      first: (v) => `We can do your order ${v.what} with these changes:`,
      revised: (v) => `We have changed what we suggested for your order ${v.what}:`,
      answerBy: (v) =>
        `Please answer by ${v.deadline}. If the changes do not suit you, decline them and we will close your order, or tell us what you would change.`,
    },
    retracted: {
      subject: (v) => `About ${v.what}`,
      time: (v) =>
        `We have withdrawn the time we suggested for ${v.what}. Your request stays with us, and we will write to you again soon.`,
      order: (v) =>
        `We have withdrawn the changes we suggested to your order ${v.what}. Your order stays with us, and we will write to you again soon.`,
      quote: (v) =>
        `We have withdrawn our quote for ${v.what}. Your request stays with us, and we will write to you again soon.`,
    },
    expired: {
      subject: (v) => `Closed: ${v.what}`,
      time: (v) =>
        `The time we suggested for ${v.what} has lapsed: it could be accepted until ${v.deadline}. Write to us if you would still like to come.`,
      quote: (v) =>
        `Our quote for ${v.what} expired on ${v.validThrough}. Reply to this email and we will gladly send you a new one.`,
      order: (v) =>
        `The changes we suggested to your order ${v.what} have lapsed, so the order is closed. Write to us whenever you like.`,
      unanswered: (v) =>
        `We are sorry: we could not answer in time, so we have closed your request: ${v.what}. Write to us whenever you like.`,
      waitingOnYou: (v) =>
        `We did not hear back from you about ${v.what}, so we have closed your request. Write to us whenever you like and we will pick it up.`,
    },
    counterReceived: {
      subject: (v) => `We have your suggestion: ${v.what}`,
      order: (v) => `Thank you. We have your changes to your order ${v.what}; we will reply soon.`,
      quote: (v) => `Thank you. We have your request for a new quote for ${v.what}; we will reply soon.`,
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
    change: {
      askTimeSubject: (v) => `Can we move ${v.what}?`,
      askOrderSubject: (v) => `A change to your order ${v.what}`,
      askTime: (v) =>
        `Can we move your booking ${v.what} from ${v.when} to ${v.newWhen}? If that does not suit you, your booking stays as it is.`,
      askOrder: (v) =>
        `We would like to change your order ${v.what} as below. If that does not suit you, your order stays as it is.`,
      answerBy: (v) => `Please answer by ${v.deadline}.`,
      answerByHeld: (v) => `Please answer by ${v.deadline}. We are keeping the new time for you until then.`,
      receivedSubject: (v) => `We have your request: ${v.what}`,
      receivedTime: (v) =>
        `We have received your request to move ${v.what} to ${v.newWhen}. Until we confirm, your booking stays for ${v.when}.`,
      receivedOrder: (v) =>
        `We have received your changes to your order ${v.what}. Until we confirm them, your order stays as it is.`,
      doneSubject: (v) => `Changed: ${v.what}`,
      doneTime: (v) => `Done: your booking ${v.what} is now for ${v.when}.`,
      doneOrder: (v) => `Done: your order ${v.what} is changed:`,
      keptSubject: (v) => `No change: ${v.what}`,
      weCantTime: (v) => `We cannot move ${v.what} to ${v.newWhen}, so your booking stays for ${v.when}.`,
      weCantOrder: (v) => `We cannot make the changes you asked for to your order ${v.what}, so it stays as it is.`,
      keptTime: (v) => `Thank you for letting us know. Your booking ${v.what} stays for ${v.when}.`,
      keptOrder: (v) => `Thank you for letting us know. Your order ${v.what} stays as it is.`,
      withdrawnTime: (v) => `We have withdrawn the change we suggested to ${v.what}; your booking stays for ${v.when}.`,
      withdrawnOrder: (v) => `We have withdrawn the change we suggested to your order ${v.what}; it stays as it is.`,
      lapsedOursTime: (v) => `Our suggestion to move ${v.what} has lapsed; your booking stays for ${v.when}.`,
      lapsedOursOrder: (v) => `The change we suggested to your order ${v.what} has lapsed; it stays as it is.`,
      lapsedYoursTime: (v) =>
        `We are sorry: we could not answer your request to move ${v.what} in time, so your booking stays for ${v.when}. Write to us if you would still like to change it.`,
      lapsedYoursOrder: (v) =>
        `We are sorry: we could not answer your changes to your order ${v.what} in time, so it stays as it is. Write to us if you would still like to change it.`,
      newTotal: (v) => `New total: ${v.total}`,
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
      acceptedChanges: (v) => `Thank you. Your order ${v.what} is confirmed, with the changes we agreed:`,
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
  withdrawal: {
    label: "Withdraw from contract here",
    confirm: "Confirm withdrawal",
    lineGoods: (v) => `You can withdraw within ${v.days} days of receiving it, without giving a reason.`,
    lineService: (v) => `You can withdraw within ${v.days} days of booking, without giving a reason.`,
    startsEarly:
      "It starts within that time: by confirming, you ask us to start then. If you withdraw after it has started, you pay for what we have done; once it is fully done, you can no longer withdraw.",
    until: (v) => `You can withdraw until ${v.deadline}, without giving a reason.`,
    except: {
      personalised: "This cannot be returned: it is made to your order.",
      perishable: "This cannot be returned: it does not keep.",
      sealed_hygiene: "This cannot be returned once unsealed, for hygiene reasons.",
      sealed_media: "This cannot be returned once unsealed.",
      mixed: "This cannot be returned once mixed with other goods.",
      dated_leisure: "There is no right of withdrawal for this: it is for a set date.",
      urgent_repair: "There is no right of withdrawal for this: it is an urgent repair you asked for.",
      digital_started: "This cannot be returned once you start it.",
      price_fluctuates: "This cannot be returned: its price follows the markets.",
    },
    receivedSubject: (v) => `We have received your withdrawal: ${v.what}`,
    received: (v) =>
      `You withdrew from ${v.what} on ${v.when}. Thank you for letting us know. This is what you sent us:`,
    statement: (v) => `I withdraw from my contract for ${v.what} (reference ${v.ref}).`,
    refundBy: (v) => `We will refund ${v.amount} by ${v.deadline}, to the way you paid.`,
    sendBack: (v) => `Please send the items back by ${v.deadline}.`,
    sendBackTo: (v) => `Please send the items back to ${v.address} by ${v.deadline}.`,
    refundOnReturn: (v) => `We will refund ${v.amount} once they reach us, or once you show us you sent them.`,
    postageCustomer: "Sending them back is at your cost.",
    postageUs: "We pay for sending them back.",
    modelForm: (v) =>
      [
        "Model withdrawal form (complete and return this form only if you wish to withdraw from the contract):",
        `— To ${v.business}${v.address ? `, ${v.address}` : ""}`,
        `— I/We hereby give notice that I/We withdraw from my/our contract of sale of the following goods / for the provision of the following service: ${v.what} (reference ${v.ref})`,
        "— Ordered on / received on:",
        "— Name of consumer(s):",
        "— Address of consumer(s):",
        "— Signature of consumer(s) (only if this form is notified on paper):",
        "— Date:",
      ].join("\n"),
    vatLabel: "VAT",
    passedOn: (v) =>
      `We have passed your message to a person on our team, who will reply soon.${v.status ? ` ${v.status}` : ""}`,
    noRight: (v) => `${cap(v.yourNoun)} can no longer be withdrawn from online.`,
    page: {
      heading: "Withdraw from your contract",
      lead: "Check your details below. We will email you a copy of what you send.",
      name: "Name",
      contract: "Contract",
      email: "Email for your copy",
      note: "Anything you want to tell us, like only some of the items? (optional)",
      done: (v) => `Your withdrawal was sent on ${v.when}. We have emailed you a copy.`,
      stillSend: "You can still send it: a person on our team will answer.",
    },
  },
  returns: {
    status: {
      requested: (v) => `Your return ${v.what ? `${v.what} ` : ""}is with us; we will answer soon. Reference ${v.ref}.`,
      approvedBack: (v) =>
        `Your return ${v.what ? `${v.what} ` : ""}is agreed: please send it back${v.deadline ? ` by ${v.deadline}` : ""}. We will refund ${v.amount} once it reaches us. Reference ${v.ref}.`,
      approvedRefund: (v) =>
        `Your refund of ${v.amount}${v.what ? ` for ${v.what}` : ""} is agreed${v.deadline ? `: we will refund you by ${v.deadline}` : ""}. Reference ${v.ref}.`,
      goodsReceived: (v) =>
        `The items you sent back${v.what ? ` for ${v.what}` : ""} have reached us: we will refund ${v.amount}${v.deadline ? ` by ${v.deadline}` : ""}. Reference ${v.ref}.`,
      disputed: (v) =>
        `The items that came back${v.what ? ` for ${v.what}` : ""} are not what we sold you: we are holding the refund while we sort it out with you. Reference ${v.ref}.`,
      refunded: (v) => `We have refunded ${v.amount}${v.what ? ` for ${v.what}` : ""}. Reference ${v.ref}.`,
      rejected: (v) => `We could not accept your return${v.what ? ` ${v.what}` : ""}. Reference ${v.ref}.`,
      cancelled: (v) => `Your return${v.what ? ` ${v.what}` : ""} is cancelled, as you asked. Reference ${v.ref}.`,
    },
    subject: (v) => `Your return${v.what ? `: ${v.what}` : ""}`,
    received: (v) =>
      `We have received your request to return ${v.what || "your items"}. We will answer within ${v.hours} hours.`,
    faulty: (v) =>
      `We are sorry ${v.what || "it"} is not right. We will answer within ${v.hours} hours, and sending it back costs you nothing.`,
    approvedBack: (v) =>
      `You can send ${v.what || "the items"} back.${v.deadline ? ` Please send ${v.what ? "it" : "them"} by ${v.deadline}.` : ""}`,
    approvedRefund: (v) =>
      `We will refund ${v.amount}${v.what ? ` for ${v.what}` : ""}${v.deadline ? ` by ${v.deadline}` : ""}, to the way you paid.`,
    method: {
      post: "Send it by post.",
      drop_off: "Bring it to us.",
      collection: "We will collect it from you.",
    },
    goodsBack: (v) =>
      `We have received the items you sent back. We will refund ${v.amount} by ${v.deadline}, to the way you paid.`,
    goodsBackLater: (v) =>
      `We have received the items you sent back. We will refund ${v.amount} soon, to the way you paid.`,
    refunded: (v) =>
      `We have refunded ${v.amount} to the way you paid${v.paymentRef ? ` (reference ${v.paymentRef})` : ""}.`,
    rejected: (v) => `We cannot accept the return${v.what ? ` of ${v.what}` : ""}:`,
    disagree: "If you disagree, reply to this email.",
    complaints: (v) => `You can also make a complaint at ${v.url}.`,
    disputed: (v) => `The items we received${v.what ? ` for ${v.what}` : ""} are not what we sold you:`,
    disputedNext:
      "We are holding the refund while we sort this out with you. Reply to this email to tell us what happened.",
    cancelled: (v) => `Your return${v.what ? ` ${v.what}` : ""} is cancelled, as you asked.`,
    cancelledPaid: (v) => `We will refund ${v.amount} by ${v.deadline}, to the way you paid.`,
    refundToAsk: (v) => `We will be in touch about refunding the ${v.amount} you paid.`,
    labels: { sendBack: "Send it back", cancel: "Cancel the return" },
    problems: {
      returnOpen: (v) => `We already have your return request (reference ${v.ref}). Write to us to add to it.`,
      noWithdrawal: (v) =>
        `${cap(v.yourNoun)} can no longer be withdrawn from online. Write to us and we will help you.`,
      nothingToReturn: "Nothing has been sent to you yet: to change your mind, cancel instead.",
      alreadyBack:
        "What you named has already come back to us and been refunded. Write to us if something is not right.",
      nothingToKeep:
        "There is nothing to send back: we will refund you as we said. Write to us if something is not right.",
      notAgreed: "Nothing is agreed yet: to change your mind, simply cancel.",
    },
  },
  confirmStep: {
    booking: (v) => `Please check before you confirm: ${v.what} on ${v.when}. Total ${v.total}.`,
    order: (v) => `Please check before you confirm: ${v.summary}. Total ${v.total}.`,
    trader: (v) => `From ${v.business}${v.address ? `, ${v.address}` : ""}.`,
    obligation: (v) => `Confirming means an obligation to pay ${v.total}.`,
  },
};

/**
 * The right of withdrawal in the UK's words (Consumer Contracts Regulations 2013): cancel, a
 * cancellation, the model cancellation form. English only; used where `commerce.legal.country` is GB.
 */
export const WITHDRAWAL_UK: WithdrawalCopy = {
  ...EN.withdrawal,
  label: "Cancel this contract here",
  confirm: "Confirm cancellation",
  lineGoods: (v) => `You can cancel within ${v.days} days of receiving it, without giving a reason.`,
  lineService: (v) => `You can cancel within ${v.days} days of booking, without giving a reason.`,
  startsEarly:
    "It starts within that time: by confirming, you ask us to start then. If you cancel after it has started, you pay for what we have done; once it is fully done, you can no longer cancel.",
  until: (v) => `You can cancel until ${v.deadline}, without giving a reason.`,
  except: {
    ...EN.withdrawal.except,
    dated_leisure: "There is no right to cancel this: it is for a set date.",
    urgent_repair: "There is no right to cancel this: it is an urgent repair you asked for.",
  },
  receivedSubject: (v) => `We have received your cancellation: ${v.what}`,
  received: (v) => `You cancelled ${v.what} on ${v.when}. Thank you for letting us know. This is what you sent us:`,
  statement: (v) => `I cancel my contract for ${v.what} (reference ${v.ref}).`,
  modelForm: (v) =>
    [
      "Model cancellation form (complete and return this form only if you wish to cancel the contract):",
      `— To ${v.business}${v.address ? `, ${v.address}` : ""}`,
      `— I/We hereby give notice that I/We cancel my/our contract of sale of the following goods / for the supply of the following service: ${v.what} (reference ${v.ref})`,
      "— Ordered on / received on:",
      "— Name of consumer(s):",
      "— Address of consumer(s):",
      "— Signature of consumer(s) (only if this form is notified on paper):",
      "— Date:",
    ].join("\n"),
  noRight: (v) => `${cap(v.yourNoun)} can no longer be cancelled online.`,
  page: {
    ...EN.withdrawal.page,
    heading: "Cancel your contract",
    done: (v) => `Your cancellation was sent on ${v.when}. We have emailed you a copy.`,
  },
};

const PT: Copy = {
  yourNoun: {
    booking: "a sua marcação",
    order: "a sua encomenda",
    quote_request: "o seu pedido de orçamento",
    message: "a sua mensagem",
    refund: "a sua devolução",
  },
  gender: { booking: "f", order: "f", quote_request: "m", message: "f", refund: "f" },
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
    goods_received: "chegou até nós",
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
  personalised: (v) =>
    `O seu preço: ${v.total} (o nosso preço: ${v.listPrice}). Este preço foi personalizado com base numa decisão automatizada.`,
  price: (v) => `Preço: ${v.total}.`,
  proposed: (v) =>
    `Sugerimos outra hora para a sua marcação${v.what ? ` ${v.what}` : ""}: ${v.newWhen}.${v.priceLine ? ` ${v.priceLine}` : ""} Responda até ${v.deadline}: aceite, recuse ou escolha outra hora. Referência ${v.ref}.`,
  proposedOrder: (v) =>
    `Sugerimos algumas alterações à sua encomenda${v.what ? ` ${v.what}` : ""}: ${v.summary}. Total ${v.total}. Responda até ${v.deadline}: aceite, recuse ou diga-nos o que mudaria. Referência ${v.ref}.`,
  changeAsked: (v) =>
    `Queremos mudar a sua marcação${v.what ? ` ${v.what}` : ""} de ${v.when} para ${v.newWhen}.${v.priceLine ? ` ${v.priceLine}` : ""} Responda até ${v.deadline}: aceite a alteração ou mantenha a marcação como está. Referência ${v.ref}.`,
  changeAskedOrder: (v) =>
    `Queremos alterar a sua encomenda${v.what ? ` ${v.what}` : ""} para: ${v.summary}. Total ${v.total}. Responda até ${v.deadline}: aceite a alteração ou mantenha a encomenda como está. Referência ${v.ref}.`,
  changeRequested: {
    time: (v) => `Pediu para a mudar para ${v.newWhen}; até respondermos, fica como está.`,
    order: "Pediu alterações; até respondermos, fica como está.",
  },
  quoted: (v) =>
    `O nosso orçamento para ${v.what || "o seu pedido"}: ${v.total}, válido até ${v.validThrough}.${v.when ? ` É para ${v.when}.` : ""} Aceite ou recuse. Referência ${v.ref}.`,
  quotedFor: (v) => `É para ${v.when}.`,
  obligation: (v) => `Aceitar implica a obrigação de pagar ${v.total}.`,
  withdrawable: "Até aceitar, ainda podemos retirar o que propusemos.",
  lastMessage: "A nossa última mensagem:",
  labels: {
    accept: "Aceitar",
    decline: "Recusar",
    otherTime: "Escolher outra hora",
    details: "Enviar os detalhes",
    cancel: "Cancelar",
    write: "Escrever-nos",
    suggestChange: "Sugerir uma alteração",
    acceptChange: "Aceitar a alteração",
    keepAsIs: "Manter como está",
    changeTime: "Mudar a hora",
    withdrawChange: "Retirar o meu pedido",
  },
  problems: {
    offerChanged: (v) => `Alterámos a nossa proposta desde que a leu. A atual: ${v.summary}`,
    offerExpired: (v) => `O nosso orçamento era válido até ${v.validThrough}. Peça-nos um novo.`,
    timeLapsed: (v) => `A hora que sugerimos podia ser aceite até ${v.deadline}. Escolha outra hora ou escreva-nos.`,
    changesLapsed: (v) =>
      `As alterações que sugerimos podiam ser aceites até ${v.deadline}. Escreva-nos e voltamos a ver a sua encomenda.`,
    passedOn: (v) =>
      `Passámos isto a uma pessoa da nossa equipa, que responde em breve.${v.deadline ? ` O que propusemos mantém-se até ${v.deadline}.` : ""}`,
    noOffer: "Neste momento não há nada para aceitar.",
    nothingToAnswer: "Neste momento não há nada nosso a que responder.",
    slotTaken: "Essa hora já não está livre.",
    timeNotFree: (v) => `${v.when} não está livre. Escolha uma das horas livres.`,
    notTooSoon: "Já é demasiado tarde para marcar essa hora.",
    pastStart: "Essa hora já passou.",
    notYours: "Isto pertence a outra pessoa.",
    notFound: "Não encontramos isto.",
    noChange: "Neste momento não há nenhuma alteração a que responder.",
    changeLapsed: (v) => `A alteração que sugerimos podia ser aceite até ${v.deadline}; mantém-se o que combinámos.`,
    changesExhausted: "Uma pessoa da nossa equipa vai responder a esta alteração. Até lá, mantém-se o que combinámos.",
    changeByPerson:
      "Não conseguimos fazer esta alteração online neste momento; uma pessoa da nossa equipa trata disso consigo. Mantém-se o que combinámos.",
    sameAsAgreed: "Isso já é o que combinámos.",
    changePassedOn: (v) =>
      `Passámos o seu pedido a uma pessoa da nossa equipa, que responde em breve. ${cap(v.yourNoun)} mantém-se como combinado${v.when ? `, para ${v.when}` : ""}.`,
  },
  mail: {
    accept: "Aceitar",
    decline: "Recusar",
    otherTime: "Escolher outra hora",
    details: "Enviar os detalhes",
    replyToAnswer: "Responda a este email para aceitar, recusar ou pedir outra hora.",
    replyToAnswerOrder: "Responda a este email para aceitar ou recusar, ou para nos dizer o que mudaria.",
    replyWithDetails: "Responda a este email com os detalhes.",
    acceptChange: "Aceitar a alteração",
    keepAsIs: "Manter como está",
    changeTime: "Mudar a hora",
    replyToAnswerChange: "Responda a este email para aceitar a alteração ou para manter tudo como está.",
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
      delivery: "Entrega",
      now: "Agora",
      instead: "Em vez disso",
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
      lapsed: (v) =>
        `A hora que sugerimos podia ser aceite até ${v.deadline}. Escolha outra hora ou responda ao nosso email.`,
      held: "Guardamos esta hora para si até responder.",
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
    acceptOrder: {
      heading: "Aceitar as nossas alterações?",
      lead: (v) => `A sua encomenda${v.what ? ` ${v.what}` : ""}, com as alterações que sugerimos:`,
      buttonPriced: "Encomenda com obrigação de pagar",
      buttonFree: "Confirmar encomenda",
      done: (v) =>
        `Obrigado: a sua encomenda ${v.what} está confirmada. Total ${v.total}. Enviámos-lhe uma confirmação por email.`,
      lapsed: (v) =>
        `As alterações que sugerimos podiam ser aceites até ${v.deadline}. Responda ao nosso email e voltamos a ver a sua encomenda.`,
    },
    declineOrder: {
      heading: "Recusar as nossas alterações?",
      body: (v) =>
        `Se recusar, fechamos a sua encomenda${v.what ? ` ${v.what}` : ""}. Preferia outra coisa? Responda ao nosso email e diga-nos.`,
      button: "Recusar e fechar a encomenda",
      done: "A sua encomenda foi fechada. Obrigado por nos avisar.",
    },
    acceptChange: {
      heading: "Aceitar esta alteração?",
      lead: (v) => `Queremos alterar ${v.yourNoun}${v.what ? ` ${v.what}` : ""}. Se não lhe convier, fica como está.`,
      buttonPriced: "Encomenda com obrigação de pagar",
      buttonFree: "Confirmar a alteração",
      doneTime: (v) =>
        `Feito: ${v.yourNoun}${v.what ? ` ${v.what}` : ""} passa para ${v.when}. Enviámos-lhe uma confirmação por email.`,
      doneOrder: (v) =>
        `Feito: a sua encomenda${v.what ? ` ${v.what}` : ""} foi alterada. Total ${v.total}. Enviámos-lhe uma confirmação por email.`,
      lapsed: (v) => `A alteração que sugerimos podia ser aceite até ${v.deadline}; ${v.yourNoun} fica como está.`,
    },
    keepAsIs: {
      heading: "Manter como está?",
      body: (v) =>
        `Mantemos ${v.yourNoun}${v.what ? ` ${v.what}` : ""}${v.when ? ` para ${v.when}` : ""}, como combinado.`,
      button: "Manter como está",
      done: (v) => `${cap(v.yourNoun)}${v.what ? ` ${v.what}` : ""} fica como está. Obrigado por nos avisar.`,
    },
    changeTime: {
      heading: "Mudar a hora",
      lead: (v) =>
        `Horas livres para ${v.what || "a sua marcação"}. Até confirmarmos a nova hora, a sua marcação mantém-se para ${v.when}. As horas estão em ${v.zone}.`,
      button: "Pedir esta hora",
      done: (v) =>
        `Recebemos o seu pedido para mudar ${v.what || "a sua marcação"} para ${v.newWhen}. Até confirmarmos, a sua marcação mantém-se para ${v.when}.`,
    },
    passedOn: (v) =>
      `Obrigado. Passámos isto a uma pessoa da nossa equipa, que responde em breve.${v.deadline ? ` O que propusemos mantém-se até ${v.deadline}.` : ""}`,
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
      revised: (v) => `Alterámos a hora que sugerimos para ${v.what}: passa a ser ${v.newWhen}.`,
      youAsked: (v) => `(Pediu ${v.askedWhen}.)`,
      answerBy: (v) => `Responda até ${v.deadline}. A hora fica sua se ainda estiver livre quando disser que sim.`,
      answerByHeld: (v) => `Responda até ${v.deadline}. Guardamos a hora para si até lá.`,
    },
    orderProposed: {
      subject: (v) => `Sobre a sua encomenda ${v.what}: veja as nossas alterações`,
      first: (v) => `Podemos fazer a sua encomenda ${v.what} com estas alterações:`,
      revised: (v) => `Alterámos o que sugerimos para a sua encomenda ${v.what}:`,
      answerBy: (v) =>
        `Responda até ${v.deadline}. Se as alterações não lhe convierem, recuse-as e fechamos a encomenda, ou diga-nos o que mudaria.`,
    },
    retracted: {
      subject: (v) => `Sobre ${v.what}`,
      time: (v) =>
        `Retirámos a hora que sugerimos para ${v.what}. O seu pedido fica connosco e voltamos a escrever-lhe em breve.`,
      order: (v) =>
        `Retirámos as alterações que sugerimos à sua encomenda ${v.what}. A sua encomenda fica connosco e voltamos a escrever-lhe em breve.`,
      quote: (v) =>
        `Retirámos o nosso orçamento para ${v.what}. O seu pedido fica connosco e voltamos a escrever-lhe em breve.`,
    },
    expired: {
      subject: (v) => `Encerrado: ${v.what}`,
      time: (v) =>
        `A hora que sugerimos para ${v.what} caducou: podia ser aceite até ${v.deadline}. Escreva-nos se ainda quiser vir.`,
      quote: (v) =>
        `O nosso orçamento para ${v.what} expirou a ${v.validThrough}. Responda a este email e enviamos-lhe um novo com todo o gosto.`,
      order: (v) =>
        `As alterações que sugerimos à sua encomenda ${v.what} caducaram, por isso a encomenda foi encerrada. Escreva-nos quando quiser.`,
      unanswered: (v) =>
        `Lamentamos: não conseguimos responder a tempo, por isso encerrámos o seu pedido: ${v.what}. Escreva-nos quando quiser.`,
      waitingOnYou: (v) =>
        `Não tivemos resposta sua sobre ${v.what}, por isso encerrámos o seu pedido. Escreva-nos quando quiser e retomamos.`,
    },
    counterReceived: {
      subject: (v) => `Recebemos a sua sugestão: ${v.what}`,
      order: (v) => `Obrigado. Recebemos as suas alterações à encomenda ${v.what}; respondemos em breve.`,
      quote: (v) => `Obrigado. Recebemos o seu pedido de um novo orçamento para ${v.what}; respondemos em breve.`,
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
    change: {
      askTimeSubject: (v) => `Podemos mudar ${v.what}?`,
      askOrderSubject: (v) => `Uma alteração à sua encomenda ${v.what}`,
      askTime: (v) =>
        `Podemos mudar a sua marcação ${v.what} de ${v.when} para ${v.newWhen}? Se não lhe der jeito, a sua marcação fica como está.`,
      askOrder: (v) =>
        `Queremos alterar a sua encomenda ${v.what} como se segue. Se não lhe convier, a sua encomenda fica como está.`,
      answerBy: (v) => `Responda até ${v.deadline}.`,
      answerByHeld: (v) => `Responda até ${v.deadline}. Guardamos a nova hora para si até lá.`,
      receivedSubject: (v) => `Recebemos o seu pedido: ${v.what}`,
      receivedTime: (v) =>
        `Recebemos o seu pedido para mudar ${v.what} para ${v.newWhen}. Até confirmarmos, a sua marcação mantém-se para ${v.when}.`,
      receivedOrder: (v) =>
        `Recebemos as suas alterações à encomenda ${v.what}. Até as confirmarmos, a sua encomenda fica como está.`,
      doneSubject: (v) => `Alterado: ${v.what}`,
      doneTime: (v) => `Feito: a sua marcação ${v.what} passa para ${v.when}.`,
      doneOrder: (v) => `Feito: a sua encomenda ${v.what} foi alterada:`,
      keptSubject: (v) => `Sem alterações: ${v.what}`,
      weCantTime: (v) =>
        `Não conseguimos mudar ${v.what} para ${v.newWhen}, por isso a sua marcação mantém-se para ${v.when}.`,
      weCantOrder: (v) =>
        `Não conseguimos fazer as alterações que pediu à sua encomenda ${v.what}, por isso fica como está.`,
      keptTime: (v) => `Obrigado por nos avisar. A sua marcação ${v.what} mantém-se para ${v.when}.`,
      keptOrder: (v) => `Obrigado por nos avisar. A sua encomenda ${v.what} fica como está.`,
      withdrawnTime: (v) =>
        `Retirámos a alteração que sugerimos para ${v.what}; a sua marcação mantém-se para ${v.when}.`,
      withdrawnOrder: (v) => `Retirámos a alteração que sugerimos à sua encomenda ${v.what}; fica como está.`,
      lapsedOursTime: (v) => `A nossa sugestão para mudar ${v.what} caducou; a sua marcação mantém-se para ${v.when}.`,
      lapsedOursOrder: (v) => `A alteração que sugerimos à sua encomenda ${v.what} caducou; fica como está.`,
      lapsedYoursTime: (v) =>
        `Lamentamos: não conseguimos responder a tempo ao seu pedido para mudar ${v.what}, por isso a sua marcação mantém-se para ${v.when}. Escreva-nos se ainda a quiser mudar.`,
      lapsedYoursOrder: (v) =>
        `Lamentamos: não conseguimos responder a tempo às suas alterações à encomenda ${v.what}, por isso fica como está. Escreva-nos se ainda a quiser alterar.`,
      newTotal: (v) => `Novo total: ${v.total}`,
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
      acceptedChanges: (v) => `Obrigado. A sua encomenda ${v.what} está confirmada, com as alterações combinadas:`,
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
  withdrawal: {
    label: "Retrate-se do contrato aqui",
    confirm: "Confirmar retratação",
    lineGoods: (v) => `Pode retratar-se no prazo de ${v.days} dias após a receção, sem indicar motivo.`,
    lineService: (v) => `Pode retratar-se no prazo de ${v.days} dias após a marcação, sem indicar motivo.`,
    startsEarly:
      "Começa dentro desse prazo: ao confirmar, pede-nos para começar nessa data. Se se retratar depois de começar, paga o que já tivermos feito; depois de concluído, já não se pode retratar.",
    until: (v) => `Pode retratar-se até ${v.deadline}, sem indicar motivo.`,
    except: {
      personalised: "Não pode ser devolvido: é feito por medida para si.",
      perishable: "Não pode ser devolvido: estraga-se rapidamente.",
      sealed_hygiene: "Não pode ser devolvido depois de aberto, por razões de higiene.",
      sealed_media: "Não pode ser devolvido depois de aberto o selo.",
      mixed: "Não pode ser devolvido depois de misturado com outros bens.",
      dated_leisure: "Não dá direito de livre resolução: é para uma data marcada.",
      urgent_repair: "Não dá direito de livre resolução: é uma reparação urgente que pediu.",
      digital_started: "Não pode ser devolvido depois de começar.",
      price_fluctuates: "Não pode ser devolvido: o preço depende dos mercados.",
    },
    receivedSubject: (v) => `Recebemos a sua retratação: ${v.what}`,
    received: (v) => `Retratou-se de ${v.what} em ${v.when}. Obrigado por nos avisar. Eis o que nos enviou:`,
    statement: (v) => `Retrato-me do meu contrato relativo a ${v.what} (referência ${v.ref}).`,
    refundBy: (v) => `Devolvemos ${v.amount} até ${v.deadline}, pelo mesmo meio de pagamento.`,
    sendBack: (v) => `Por favor, devolva os artigos até ${v.deadline}.`,
    sendBackTo: (v) => `Por favor, devolva os artigos para ${v.address} até ${v.deadline}.`,
    refundOnReturn: (v) =>
      `Devolvemos ${v.amount} quando os artigos nos chegarem, ou quando nos mostrar que os enviou.`,
    postageCustomer: "O custo da devolução é seu.",
    postageUs: "Nós pagamos a devolução.",
    modelForm: (v) =>
      [
        "Modelo de formulário de livre resolução (só deve preencher e devolver o presente formulário se quiser resolver o contrato):",
        `— Para ${v.business}${v.address ? `, ${v.address}` : ""}`,
        `— Pela presente comunico/comunicamos que resolvo/resolvemos do meu/nosso contrato de venda do seguinte bem / para a prestação do seguinte serviço: ${v.what} (referência ${v.ref})`,
        "— Solicitado em / recebido em:",
        "— Nome do(s) consumidor(es):",
        "— Endereço do(s) consumidor(es):",
        "— Assinatura do(s) consumidor(es) (só no caso de o presente formulário ser notificado em papel):",
        "— Data:",
      ].join("\n"),
    vatLabel: "NIF",
    passedOn: (v) =>
      `Passámos a sua mensagem a uma pessoa da nossa equipa, que responde em breve.${v.status ? ` ${v.status}` : ""}`,
    noRight: (v) =>
      `Já não é possível retratar-se online d${v.yourNoun.startsWith("o ") ? "o" : "a"} ${v.yourNoun.replace(/^(o|a) /, "")}.`,
    page: {
      heading: "Retratar-se do contrato",
      lead: "Confirme os seus dados. Enviamos-lhe por email uma cópia do que enviar.",
      name: "Nome",
      contract: "Contrato",
      email: "Email para a sua cópia",
      note: "Quer dizer-nos alguma coisa, por exemplo só alguns artigos? (opcional)",
      done: (v) => `A sua retratação foi enviada em ${v.when}. Enviámos-lhe uma cópia por email.`,
      stillSend: "Pode enviá-la na mesma: uma pessoa da nossa equipa responde.",
    },
  },
  returns: {
    status: {
      requested: (v) =>
        `A sua devolução${v.what ? ` ${v.what}` : ""} está connosco; respondemos em breve. Referência ${v.ref}.`,
      approvedBack: (v) =>
        `A sua devolução${v.what ? ` ${v.what}` : ""} foi aceite: por favor, devolva os artigos${v.deadline ? ` até ${v.deadline}` : ""}. Devolvemos ${v.amount} quando nos chegarem. Referência ${v.ref}.`,
      approvedRefund: (v) =>
        `O seu reembolso de ${v.amount}${v.what ? ` para ${v.what}` : ""} foi aceite${v.deadline ? `: devolvemos até ${v.deadline}` : ""}. Referência ${v.ref}.`,
      goodsReceived: (v) =>
        `Os artigos que devolveu${v.what ? ` de ${v.what}` : ""} chegaram: devolvemos ${v.amount}${v.deadline ? ` até ${v.deadline}` : ""}. Referência ${v.ref}.`,
      disputed: (v) =>
        `Os artigos que nos chegaram${v.what ? ` de ${v.what}` : ""} não correspondem ao que lhe vendemos: suspendemos o reembolso enquanto resolvemos isto consigo. Referência ${v.ref}.`,
      refunded: (v) => `Devolvemos ${v.amount}${v.what ? ` de ${v.what}` : ""}. Referência ${v.ref}.`,
      rejected: (v) => `Não pudemos aceitar a sua devolução${v.what ? ` ${v.what}` : ""}. Referência ${v.ref}.`,
      cancelled: (v) => `A sua devolução${v.what ? ` ${v.what}` : ""} foi cancelada, como pediu. Referência ${v.ref}.`,
    },
    subject: (v) => `A sua devolução${v.what ? `: ${v.what}` : ""}`,
    received: (v) =>
      `Recebemos o seu pedido de devolução${v.what ? ` de ${v.what}` : ""}. Respondemos dentro de ${v.hours} horas.`,
    faulty: (v) =>
      `Lamentamos que ${v.what || "o artigo"} tenha um problema. Respondemos dentro de ${v.hours} horas, e a devolução não tem custos para si.`,
    approvedBack: (v) =>
      `Pode devolver ${v.what || "os artigos"}.${v.deadline ? ` Por favor, envie até ${v.deadline}.` : ""}`,
    approvedRefund: (v) =>
      `Devolvemos ${v.amount}${v.what ? ` de ${v.what}` : ""}${v.deadline ? ` até ${v.deadline}` : ""}, pelo mesmo meio de pagamento.`,
    method: {
      post: "Envie pelo correio.",
      drop_off: "Traga-o até nós.",
      collection: "Vamos buscá-lo.",
    },
    goodsBack: (v) =>
      `Recebemos os artigos que devolveu. Devolvemos ${v.amount} até ${v.deadline}, pelo mesmo meio de pagamento.`,
    goodsBackLater: (v) =>
      `Recebemos os artigos que devolveu. Devolvemos ${v.amount} em breve, pelo mesmo meio de pagamento.`,
    refunded: (v) =>
      `Devolvemos ${v.amount} pelo mesmo meio de pagamento${v.paymentRef ? ` (referência ${v.paymentRef})` : ""}.`,
    rejected: (v) => `Não podemos aceitar a devolução${v.what ? ` de ${v.what}` : ""}:`,
    disagree: "Se discordar, responda a este email.",
    complaints: (v) => `Pode também usar o Livro de Reclamações: ${v.url}.`,
    disputed: (v) => `Os artigos que recebemos${v.what ? ` de ${v.what}` : ""} não correspondem ao que lhe vendemos:`,
    disputedNext:
      "Suspendemos o reembolso enquanto resolvemos isto consigo. Responda a este email para nos dizer o que aconteceu.",
    cancelled: (v) => `A sua devolução${v.what ? ` ${v.what}` : ""} foi cancelada, como pediu.`,
    cancelledPaid: (v) => `Devolvemos ${v.amount} até ${v.deadline}, pelo mesmo meio de pagamento.`,
    refundToAsk: (v) => `Vamos contactá-lo sobre o reembolso dos ${v.amount} que pagou.`,
    labels: { sendBack: "Devolver", cancel: "Cancelar a devolução" },
    problems: {
      returnOpen: (v) => `Já temos o seu pedido de devolução (referência ${v.ref}). Escreva-nos para o completar.`,
      noWithdrawal: (v) =>
        `Já não é possível retratar-se online d${v.yourNoun.startsWith("o ") ? "o" : "a"} ${v.yourNoun.replace(/^(o|a) /, "")}. Escreva-nos e ajudamos.`,
      nothingToReturn: "Ainda não lhe enviámos nada: se mudou de ideias, cancele.",
      alreadyBack: "O que indicou já nos foi devolvido e reembolsado. Escreva-nos se algo não estiver certo.",
      nothingToKeep: "Não há nada a devolver: reembolsamos como dissemos. Escreva-nos se algo não estiver certo.",
      notAgreed: "Ainda não há nada combinado: se mudou de ideias, basta cancelar.",
    },
  },
  confirmStep: {
    booking: (v) => `Confirme antes de marcar: ${v.what} para ${v.when}. Total ${v.total}.`,
    order: (v) => `Confirme antes de encomendar: ${v.summary}. Total ${v.total}.`,
    trader: (v) => `De ${v.business}${v.address ? `, ${v.address}` : ""}.`,
    obligation: (v) => `Confirmar implica a obrigação de pagar ${v.total}.`,
  },
};

export const COPY: Readonly<Record<CustomerLang, Copy>> = { en: EN, pt: PT };

export function copyFor(lang: CustomerLang): Copy {
  return COPY[lang];
}

/** The right of withdrawal in the words of the customer's language and of the law the business sells under. */
export function withdrawalCopy(lang: CustomerLang, law: "eu" | "pt" | "uk"): WithdrawalCopy {
  return lang === "en" && law === "uk" ? WITHDRAWAL_UK : COPY[lang].withdrawal;
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
    days: "",
    hours: "",
    address: "",
    paymentRef: "",
    listPrice: "",
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
