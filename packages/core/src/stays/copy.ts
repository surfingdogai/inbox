import { LODGING_VOCABULARY } from "@surfingdog/spec";
import { type PolicyLang, policyLang } from "../policy/words";

/**
 * What a place to stay says to its guests (ADR-033), in its own name and the guest's language: the
 * lines of a quote, the schedule's words, the pay-link titles, the guest pages and the emails G1–G6.
 * Six languages ship (English, Spanish, French, German, Italian, Portuguese); any other reads in
 * English, and the owner may write their own pre-arrival text in any. Nothing here names the inbox, a
 * network, receipts, passes, keys or a reputation: `customerCopyProblems` holds every string to that.
 */
export type StayLang = PolicyLang;
export const STAY_LANGS: readonly StayLang[] = ["en", "es", "fr", "de", "it", "pt"];
export const stayLang = policyLang;

/** The values a guest-facing string is filled with, all already written in the guest's language. */
export interface StayVars {
  readonly property?: string;
  readonly dates?: string;
  readonly nights?: string;
  readonly guests?: string;
  readonly total?: string;
  readonly amount?: string;
  readonly now?: string;
  readonly there?: string;
  readonly until?: string;
  readonly ref?: string;
  readonly date?: string;
  readonly time?: string;
  readonly weekday?: string;
  readonly fee?: string;
  readonly paid?: string;
  readonly refund?: string;
  readonly more?: string;
  readonly hours?: string;
  readonly note?: string;
  readonly how?: string;
  readonly due?: string;
  readonly details?: string;
  readonly free?: string;
}

type Line = (v: StayVars) => string;

export interface StayCopy {
  /** "1 night" · "3 nights" */
  readonly nights: (n: number) => string;
  /** "2 adults" · "1 child" */
  readonly adults: (n: number) => string;
  readonly children: (n: number) => string;
  /** "includes 10% consumption tax", for the room line when prices include a tax. */
  readonly includes: (rate: string, name: string) => string;
  readonly paidAtProperty: string;
  /** "Breakfast for 2" */
  readonly mealFor: (meal: string, guests: number) => string;
  readonly schedule: {
    readonly deposit: string;
    readonly balance: string;
    readonly atProperty: string;
    readonly difference: string;
    readonly now: string;
  };
  /** "3 nights from 12 Dec": a pay link's title, with the property's name and the reference around it. */
  readonly from: (nights: string, date: string) => string;
  readonly purpose: { readonly deposit: string; readonly balance: string; readonly difference: string };
  /** The line under every page and email that says who the guest deals with. */
  readonly with: Line;
  readonly automatic: Line;
  readonly notInvoice: Line;
  readonly reply: Line;
  readonly emails: {
    readonly received: { readonly subject: Line; readonly body: Line };
    readonly quote: { readonly subject: Line; readonly intro: Line; readonly holds: Line };
    readonly payNow: Line;
    readonly payParts: Line;
    readonly confirmed: { readonly subject: Line; readonly intro: string; readonly times: Line };
    readonly declined: { readonly subject: Line; readonly full: string };
    readonly expiredQuote: { readonly subject: Line; readonly body: Line };
    readonly reminder: { readonly subject: Line; readonly body: Line };
    readonly notPaid: { readonly subject: Line; readonly body: Line };
    readonly beforeArrival: { readonly subject: Line; readonly body: Line };
    readonly arrivalDetails: { readonly subject: Line; readonly body: Line };
    readonly cancelledByProperty: { readonly subject: Line; readonly refund: Line };
    readonly cancelled: { readonly subject: Line; readonly body: Line };
    readonly changed: { readonly subject: Line; readonly body: Line };
    readonly paymentReceived: { readonly subject: Line; readonly body: Line };
    readonly needsInfo: { readonly subject: Line; readonly body: Line };
    readonly thankYou: { readonly subject: Line; readonly body: Line };
  };
  readonly page: {
    readonly accept: string;
    readonly otherDates: string;
    readonly noThanks: string;
    readonly confirmAccept: Line;
    readonly book: string;
    readonly bookAndPay: string;
    readonly obligation: string;
    readonly pay: Line;
    readonly payBy: Line;
    readonly card: Line;
    readonly addCard: string;
    readonly cardSaved: string;
    readonly cancelQuestion: Line;
    readonly cancelFree: Line;
    readonly cancelNothingBack: string;
    readonly cancelRefund: Line;
    readonly cancelMine: string;
    readonly keep: string;
    readonly newTotal: Line;
    readonly payMore: Line;
    readonly refundLess: Line;
    readonly askProperty: Line;
    readonly changeMine: string;
    readonly booked: string;
    readonly reference: Line;
    readonly checkIn: Line;
    readonly checkOut: Line;
    readonly howToFind: string;
    readonly status: Readonly<Record<string, string>>;
  };
}

const EN: StayCopy = {
  nights: (n) => `${n} night${n === 1 ? "" : "s"}`,
  adults: (n) => `${n} adult${n === 1 ? "" : "s"}`,
  children: (n) => `${n} child${n === 1 ? "" : "ren"}`,
  includes: (rate, name) => `includes ${rate} ${name}`,
  paidAtProperty: "(paid at the property)",
  mealFor: (meal, n) => `${meal} for ${n}`,
  schedule: {
    deposit: "Deposit",
    balance: "Balance",
    atProperty: "At the property",
    difference: "Difference",
    now: "Now",
  },
  from: (nights, date) => `${nights} from ${date}`,
  purpose: { deposit: "deposit", balance: "balance", difference: "difference" },
  with: (v) => `Your booking is with ${v.property}.`,
  automatic: (v) => `Sent automatically by ${v.property}.`,
  notInvoice: (v) => `This is your booking confirmation, not an invoice. ${v.property} issues your invoice.`,
  reply: (v) => `Reply to this email to reach ${v.property}.`,
  emails: {
    received: {
      subject: (v) => `Your request to ${v.property}: ${v.dates}`,
      body: (v) => `Your request for ${v.dates} reached ${v.property}. ${v.property} answers within ${v.hours} hours.`,
    },
    quote: {
      subject: (v) => `Your stay at ${v.property}: ${v.dates}`,
      intro: (v) => `${v.property} can welcome you.`,
      holds: (v) => `This quote holds until ${v.until}.`,
    },
    payNow: (v) => `Pay now: ${v.now}. At the property: ${v.there}.`,
    payParts: (v) => `Pay now: ${v.now}.`,
    confirmed: {
      subject: (v) => `Booked: ${v.property}, ${v.dates}`,
      intro: "You're booked.",
      times: (v) => `Check-in from ${v.time}, check-out by ${v.until}.`,
    },
    declined: { subject: (v) => `${v.property}: no room on ${v.dates}`, full: "Sorry, we are full on those nights." },
    expiredQuote: {
      subject: (v) => `Your quote from ${v.property} has expired`,
      body: (v) =>
        `The quote for ${v.dates} was not accepted in time, so the nights are no longer held. Write to us if you would like another.`,
    },
    reminder: {
      subject: (v) => `Reminder: your deposit for ${v.dates}`,
      body: (v) => `Your deposit of ${v.amount} is due by ${v.until}.`,
    },
    notPaid: {
      subject: (v) => `Your booking at ${v.property} was not completed`,
      body: (v) =>
        `The deposit for ${v.dates} was not paid in time, so the booking was not completed and the nights are no longer held.`,
    },
    beforeArrival: {
      subject: (v) => `See you on ${v.weekday} at ${v.property}`,
      body: (v) =>
        `Check-in from ${v.time}.${v.how ? ` ${v.how}` : ""}${v.due ? ` ${v.due}` : ""} Reply to this email if you need anything.`,
    },
    arrivalDetails: {
      subject: (v) => `Arriving at ${v.property}: your details`,
      body: (v) => `Your arrival details for ${v.date}:\n\n${v.details}`,
    },
    cancelledByProperty: {
      subject: (v) => `${v.property} had to cancel your stay`,
      refund: (v) => `${v.property} refunds everything you paid: ${v.paid}.`,
    },
    cancelled: {
      subject: (v) => `Your stay at ${v.property} is cancelled`,
      body: (v) =>
        `Your stay for ${v.dates} is cancelled.${v.fee ? ` Cancellation fee: ${v.fee}.` : ""}${v.refund ? ` ${v.property} refunds ${v.refund} to how you paid.` : ""}`,
    },
    changed: {
      subject: (v) => `Your stay at ${v.property} was changed: ${v.dates}`,
      body: (v) => `Your stay is now ${v.dates}. New total ${v.total}.`,
    },
    paymentReceived: {
      subject: (v) => `Payment received: ${v.amount} (${v.ref})`,
      body: (v) => `${v.property} received your payment of ${v.amount}.`,
    },
    needsInfo: {
      subject: (v) => `${v.property} has a question about your stay`,
      body: (v) => `${v.note ?? ""}`,
    },
    thankYou: {
      subject: (v) => `Thank you for staying at ${v.property}`,
      body: () => "Thank you for staying with us. We hope to welcome you again.",
    },
  },
  page: {
    accept: "Accept and book",
    otherDates: "Ask for other dates",
    noThanks: "No thanks",
    confirmAccept: (v) => `You're booking ${v.nights}, ${v.dates}, for ${v.total}.${v.free ? ` ${v.free}` : ""}`,
    book: "Book",
    bookAndPay: "Book and pay the deposit",
    obligation: "Book with obligation to pay",
    pay: (v) => `Pay ${v.amount}`,
    payBy: (v) => `Pay the deposit of ${v.amount} to ${v.property} by ${v.until}.`,
    card: (v) =>
      `${v.property} asks for a card to hold your booking. Nothing is charged now. Under its policy it may charge a no-show or a late cancellation.`,
    addCard: "Add a card",
    cardSaved: "Your card holds the booking.",
    cancelQuestion: (v) => `Cancel your stay? It's after ${v.date}, so the fee is ${v.fee}.`,
    cancelFree: (v) => `Cancelling now is free. ${v.property} refunds your ${v.paid} to how you paid.`,
    cancelNothingBack: "There is nothing to refund.",
    cancelRefund: (v) => `You've paid ${v.paid}, so ${v.property} refunds ${v.refund}.`,
    cancelMine: "Cancel my stay",
    keep: "Keep it",
    newTotal: (v) => `New total ${v.total}`,
    payMore: (v) => `You pay ${v.more} more.`,
    refundLess: (v) => `We refund ${v.refund}.`,
    askProperty: (v) => `Ask ${v.property}`,
    changeMine: "Change my booking",
    booked: "You're booked.",
    reference: (v) => `Reference ${v.ref}`,
    checkIn: (v) => `Check-in from ${v.time}`,
    checkOut: (v) => `Check-out by ${v.time}`,
    howToFind: "How to find us",
    status: {
      requested: "Your request is with us",
      needs_info: "We need a detail from you",
      quoted: "Our quote",
      held: "Held for you",
      booking: "Being confirmed",
      awaiting_payment: "Waiting for your deposit",
      confirmed: "Booked",
      checked_in: "Welcome",
      completed: "Thank you for staying",
      no_show: "Recorded as not arrived",
      cancelled_by_guest: "Cancelled, as you asked",
      cancelled_by_property: "Cancelled by us",
      declined: "No room on those nights",
      expired: "No longer open",
    },
  },
};

const ES: StayCopy = {
  nights: (n) => `${n} noche${n === 1 ? "" : "s"}`,
  adults: (n) => `${n} adulto${n === 1 ? "" : "s"}`,
  children: (n) => `${n} niño${n === 1 ? "" : "s"}`,
  includes: (rate, name) => `incluye ${rate} de ${name}`,
  paidAtProperty: "(se paga en el alojamiento)",
  mealFor: (meal, n) => `${meal} para ${n}`,
  schedule: {
    deposit: "Depósito",
    balance: "Resto",
    atProperty: "En el alojamiento",
    difference: "Diferencia",
    now: "Ahora",
  },
  from: (nights, date) => `${nights} desde el ${date}`,
  purpose: { deposit: "depósito", balance: "resto", difference: "diferencia" },
  with: (v) => `Su reserva es con ${v.property}.`,
  automatic: (v) => `Enviado automáticamente por ${v.property}.`,
  notInvoice: (v) => `Esta es la confirmación de su reserva, no una factura. ${v.property} emite su factura.`,
  reply: (v) => `Responda a este correo para escribir a ${v.property}.`,
  emails: {
    received: {
      subject: (v) => `Su solicitud a ${v.property}: ${v.dates}`,
      body: (v) =>
        `Su solicitud para ${v.dates} ha llegado a ${v.property}. ${v.property} responde en menos de ${v.hours} horas.`,
    },
    quote: {
      subject: (v) => `Su estancia en ${v.property}: ${v.dates}`,
      intro: (v) => `${v.property} puede recibirle.`,
      holds: (v) => `Este presupuesto es válido hasta el ${v.until}.`,
    },
    payNow: (v) => `A pagar ahora: ${v.now}. En el alojamiento: ${v.there}.`,
    payParts: (v) => `A pagar ahora: ${v.now}.`,
    confirmed: {
      subject: (v) => `Reservado: ${v.property}, ${v.dates}`,
      intro: "Su reserva está hecha.",
      times: (v) => `Entrada desde las ${v.time}, salida antes de las ${v.until}.`,
    },
    declined: {
      subject: (v) => `${v.property}: sin habitaciones del ${v.dates}`,
      full: "Lo sentimos, esas noches estamos completos.",
    },
    expiredQuote: {
      subject: (v) => `Su presupuesto de ${v.property} ha caducado`,
      body: (v) =>
        `El presupuesto para ${v.dates} no se aceptó a tiempo, así que las noches ya no están reservadas. Escríbanos si desea otro.`,
    },
    reminder: {
      subject: (v) => `Recordatorio: su depósito para ${v.dates}`,
      body: (v) => `Su depósito de ${v.amount} vence el ${v.until}.`,
    },
    notPaid: {
      subject: (v) => `Su reserva en ${v.property} no se completó`,
      body: (v) =>
        `El depósito para ${v.dates} no se pagó a tiempo, así que la reserva no se completó y las noches ya no están reservadas.`,
    },
    beforeArrival: {
      subject: (v) => `Hasta el ${v.weekday} en ${v.property}`,
      body: (v) =>
        `Entrada desde las ${v.time}.${v.how ? ` ${v.how}` : ""}${v.due ? ` ${v.due}` : ""} Responda a este correo si necesita algo.`,
    },
    arrivalDetails: {
      subject: (v) => `Llegada a ${v.property}: sus datos`,
      body: (v) => `Sus datos de llegada para el ${v.date}:\n\n${v.details}`,
    },
    cancelledByProperty: {
      subject: (v) => `${v.property} ha tenido que cancelar su estancia`,
      refund: (v) => `${v.property} le devuelve todo lo que pagó: ${v.paid}.`,
    },
    cancelled: {
      subject: (v) => `Su estancia en ${v.property} está cancelada`,
      body: (v) =>
        `Su estancia del ${v.dates} está cancelada.${v.fee ? ` Gastos de cancelación: ${v.fee}.` : ""}${v.refund ? ` ${v.property} le devuelve ${v.refund}.` : ""}`,
    },
    changed: {
      subject: (v) => `Su estancia en ${v.property} ha cambiado: ${v.dates}`,
      body: (v) => `Su estancia es ahora del ${v.dates}. Nuevo total: ${v.total}.`,
    },
    paymentReceived: {
      subject: (v) => `Pago recibido: ${v.amount} (${v.ref})`,
      body: (v) => `${v.property} ha recibido su pago de ${v.amount}.`,
    },
    needsInfo: {
      subject: (v) => `${v.property} tiene una pregunta sobre su estancia`,
      body: (v) => `${v.note ?? ""}`,
    },
    thankYou: {
      subject: (v) => `Gracias por alojarse en ${v.property}`,
      body: () => "Gracias por alojarse con nosotros. Esperamos recibirle de nuevo.",
    },
  },
  page: {
    accept: "Aceptar y reservar",
    otherDates: "Pedir otras fechas",
    noThanks: "No, gracias",
    confirmAccept: (v) => `Reserva ${v.nights}, ${v.dates}, por ${v.total}.${v.free ? ` ${v.free}` : ""}`,
    book: "Reservar",
    bookAndPay: "Reservar y pagar el depósito",
    obligation: "Reservar con obligación de pago",
    pay: (v) => `Pagar ${v.amount}`,
    payBy: (v) => `Pague el depósito de ${v.amount} a ${v.property} antes del ${v.until}.`,
    card: (v) =>
      `${v.property} pide una tarjeta para garantizar su reserva. Ahora no se cobra nada. Según su política, puede cobrar si no se presenta o cancela tarde.`,
    addCard: "Añadir una tarjeta",
    cardSaved: "Su tarjeta garantiza la reserva.",
    cancelQuestion: (v) => `¿Cancelar su estancia? Es después del ${v.date}, así que el cargo es ${v.fee}.`,
    cancelFree: (v) => `Cancelar ahora es gratis. ${v.property} le devuelve sus ${v.paid}.`,
    cancelNothingBack: "No hay nada que devolver.",
    cancelRefund: (v) => `Ha pagado ${v.paid}, así que ${v.property} le devuelve ${v.refund}.`,
    cancelMine: "Cancelar mi estancia",
    keep: "Mantenerla",
    newTotal: (v) => `Nuevo total: ${v.total}`,
    payMore: (v) => `Paga ${v.more} más.`,
    refundLess: (v) => `Le devolvemos ${v.refund}.`,
    askProperty: (v) => `Preguntar a ${v.property}`,
    changeMine: "Cambiar mi reserva",
    booked: "Su reserva está hecha.",
    reference: (v) => `Referencia ${v.ref}`,
    checkIn: (v) => `Entrada desde las ${v.time}`,
    checkOut: (v) => `Salida antes de las ${v.time}`,
    howToFind: "Cómo llegar",
    status: {
      requested: "Su solicitud está con nosotros",
      needs_info: "Necesitamos un dato",
      quoted: "Nuestro presupuesto",
      held: "Reservado para usted",
      booking: "Confirmando",
      awaiting_payment: "Esperando su depósito",
      confirmed: "Reservado",
      checked_in: "Bienvenido",
      completed: "Gracias por su estancia",
      no_show: "Registrado como no presentado",
      cancelled_by_guest: "Cancelada, como pidió",
      cancelled_by_property: "Cancelada por nosotros",
      declined: "Sin habitaciones esas noches",
      expired: "Ya no está abierta",
    },
  },
};

const FR: StayCopy = {
  nights: (n) => `${n} nuit${n === 1 ? "" : "s"}`,
  adults: (n) => `${n} adulte${n === 1 ? "" : "s"}`,
  children: (n) => `${n} enfant${n === 1 ? "" : "s"}`,
  includes: (rate, name) => `dont ${rate} de ${name}`,
  paidAtProperty: "(à régler sur place)",
  mealFor: (meal, n) => `${meal} pour ${n}`,
  schedule: {
    deposit: "Acompte",
    balance: "Solde",
    atProperty: "Sur place",
    difference: "Différence",
    now: "Maintenant",
  },
  from: (nights, date) => `${nights} à partir du ${date}`,
  purpose: { deposit: "acompte", balance: "solde", difference: "différence" },
  with: (v) => `Votre réservation est avec ${v.property}.`,
  automatic: (v) => `Envoyé automatiquement par ${v.property}.`,
  notInvoice: (v) =>
    `Ceci est la confirmation de votre réservation, pas une facture. ${v.property} établit votre facture.`,
  reply: (v) => `Répondez à cet e-mail pour écrire à ${v.property}.`,
  emails: {
    received: {
      subject: (v) => `Votre demande à ${v.property} : ${v.dates}`,
      body: (v) =>
        `Votre demande pour ${v.dates} est arrivée chez ${v.property}. ${v.property} répond sous ${v.hours} heures.`,
    },
    quote: {
      subject: (v) => `Votre séjour à ${v.property} : ${v.dates}`,
      intro: (v) => `${v.property} peut vous accueillir.`,
      holds: (v) => `Ce devis est valable jusqu'au ${v.until}.`,
    },
    payNow: (v) => `À payer maintenant : ${v.now}. Sur place : ${v.there}.`,
    payParts: (v) => `À payer maintenant : ${v.now}.`,
    confirmed: {
      subject: (v) => `Réservé : ${v.property}, ${v.dates}`,
      intro: "Votre réservation est faite.",
      times: (v) => `Arrivée à partir de ${v.time}, départ avant ${v.until}.`,
    },
    declined: {
      subject: (v) => `${v.property} : pas de chambre du ${v.dates}`,
      full: "Désolés, nous sommes complets ces nuits-là.",
    },
    expiredQuote: {
      subject: (v) => `Votre devis de ${v.property} a expiré`,
      body: (v) =>
        `Le devis pour ${v.dates} n'a pas été accepté à temps, les nuits ne sont donc plus retenues. Écrivez-nous si vous en souhaitez un autre.`,
    },
    reminder: {
      subject: (v) => `Rappel : votre acompte pour ${v.dates}`,
      body: (v) => `Votre acompte de ${v.amount} est à régler avant le ${v.until}.`,
    },
    notPaid: {
      subject: (v) => `Votre réservation chez ${v.property} n'a pas abouti`,
      body: (v) =>
        `L'acompte pour ${v.dates} n'a pas été réglé à temps : la réservation n'a pas abouti et les nuits ne sont plus retenues.`,
    },
    beforeArrival: {
      subject: (v) => `À ${v.weekday} chez ${v.property}`,
      body: (v) =>
        `Arrivée à partir de ${v.time}.${v.how ? ` ${v.how}` : ""}${v.due ? ` ${v.due}` : ""} Répondez à cet e-mail si vous avez besoin de quoi que ce soit.`,
    },
    arrivalDetails: {
      subject: (v) => `Votre arrivée chez ${v.property} : les détails`,
      body: (v) => `Vos détails d'arrivée pour le ${v.date} :\n\n${v.details}`,
    },
    cancelledByProperty: {
      subject: (v) => `${v.property} a dû annuler votre séjour`,
      refund: (v) => `${v.property} vous rembourse tout ce que vous avez payé : ${v.paid}.`,
    },
    cancelled: {
      subject: (v) => `Votre séjour chez ${v.property} est annulé`,
      body: (v) =>
        `Votre séjour du ${v.dates} est annulé.${v.fee ? ` Frais d'annulation : ${v.fee}.` : ""}${v.refund ? ` ${v.property} vous rembourse ${v.refund}.` : ""}`,
    },
    changed: {
      subject: (v) => `Votre séjour chez ${v.property} a changé : ${v.dates}`,
      body: (v) => `Votre séjour est désormais du ${v.dates}. Nouveau total : ${v.total}.`,
    },
    paymentReceived: {
      subject: (v) => `Paiement bien arrivé : ${v.amount} (${v.ref})`,
      body: (v) => `${v.property} a bien reçu votre paiement de ${v.amount}.`,
    },
    needsInfo: {
      subject: (v) => `${v.property} a une question sur votre séjour`,
      body: (v) => `${v.note ?? ""}`,
    },
    thankYou: {
      subject: (v) => `Merci pour votre séjour chez ${v.property}`,
      body: () => "Merci d'avoir séjourné chez nous. Au plaisir de vous accueillir à nouveau.",
    },
  },
  page: {
    accept: "Accepter et réserver",
    otherDates: "Demander d'autres dates",
    noThanks: "Non merci",
    confirmAccept: (v) => `Vous réservez ${v.nights}, ${v.dates}, pour ${v.total}.${v.free ? ` ${v.free}` : ""}`,
    book: "Réserver",
    bookAndPay: "Réserver et payer l'acompte",
    obligation: "Réserver avec obligation de paiement",
    pay: (v) => `Payer ${v.amount}`,
    payBy: (v) => `Réglez l'acompte de ${v.amount} à ${v.property} avant le ${v.until}.`,
    card: (v) =>
      `${v.property} demande une carte pour garantir votre réservation. Rien n'est débité maintenant. Selon sa politique, une non-présentation ou une annulation tardive peut être facturée.`,
    addCard: "Ajouter une carte",
    cardSaved: "Votre carte garantit la réservation.",
    cancelQuestion: (v) => `Annuler votre séjour ? Nous sommes après le ${v.date}, les frais sont donc de ${v.fee}.`,
    cancelFree: (v) => `Annuler maintenant est gratuit. ${v.property} vous rembourse vos ${v.paid}.`,
    cancelNothingBack: "Il n'y a rien à rembourser.",
    cancelRefund: (v) => `Vous avez payé ${v.paid}, ${v.property} vous rembourse donc ${v.refund}.`,
    cancelMine: "Annuler mon séjour",
    keep: "Le garder",
    newTotal: (v) => `Nouveau total : ${v.total}`,
    payMore: (v) => `Vous payez ${v.more} de plus.`,
    refundLess: (v) => `Nous vous remboursons ${v.refund}.`,
    askProperty: (v) => `Demander à ${v.property}`,
    changeMine: "Modifier ma réservation",
    booked: "Votre réservation est faite.",
    reference: (v) => `Référence ${v.ref}`,
    checkIn: (v) => `Arrivée à partir de ${v.time}`,
    checkOut: (v) => `Départ avant ${v.time}`,
    howToFind: "Comment nous trouver",
    status: {
      requested: "Votre demande est chez nous",
      needs_info: "Il nous manque un détail",
      quoted: "Notre devis",
      held: "Retenu pour vous",
      booking: "En cours de confirmation",
      awaiting_payment: "En attente de votre acompte",
      confirmed: "Réservé",
      checked_in: "Bienvenue",
      completed: "Merci pour votre séjour",
      no_show: "Noté comme non arrivé",
      cancelled_by_guest: "Annulé, comme demandé",
      cancelled_by_property: "Annulé par nous",
      declined: "Pas de chambre ces nuits-là",
      expired: "N'est plus ouvert",
    },
  },
};

const DE: StayCopy = {
  nights: (n) => (n === 1 ? "1 Nacht" : `${n} Nächte`),
  adults: (n) => (n === 1 ? "1 Erwachsener" : `${n} Erwachsene`),
  children: (n) => (n === 1 ? "1 Kind" : `${n} Kinder`),
  includes: (rate, name) => `inkl. ${rate} ${name}`,
  paidAtProperty: "(vor Ort zu zahlen)",
  mealFor: (meal, n) => `${meal} für ${n}`,
  schedule: {
    deposit: "Anzahlung",
    balance: "Restbetrag",
    atProperty: "Vor Ort",
    difference: "Differenz",
    now: "Jetzt",
  },
  from: (nights, date) => `${nights} ab ${date}`,
  purpose: { deposit: "Anzahlung", balance: "Restbetrag", difference: "Differenz" },
  with: (v) => `Ihre Buchung besteht mit ${v.property}.`,
  automatic: (v) => `Automatisch gesendet von ${v.property}.`,
  notInvoice: (v) => `Dies ist Ihre Buchungsbestätigung, keine Rechnung. ${v.property} stellt Ihre Rechnung aus.`,
  reply: (v) => `Antworten Sie auf diese E-Mail, um ${v.property} zu schreiben.`,
  emails: {
    received: {
      subject: (v) => `Ihre Anfrage an ${v.property}: ${v.dates}`,
      body: (v) =>
        `Ihre Anfrage für ${v.dates} ist bei ${v.property} angekommen. ${v.property} antwortet innerhalb von ${v.hours} Stunden.`,
    },
    quote: {
      subject: (v) => `Ihr Aufenthalt bei ${v.property}: ${v.dates}`,
      intro: (v) => `${v.property} kann Sie gerne empfangen.`,
      holds: (v) => `Dieses Angebot gilt bis ${v.until}.`,
    },
    payNow: (v) => `Jetzt zu zahlen: ${v.now}. Vor Ort: ${v.there}.`,
    payParts: (v) => `Jetzt zu zahlen: ${v.now}.`,
    confirmed: {
      subject: (v) => `Gebucht: ${v.property}, ${v.dates}`,
      intro: "Ihre Buchung steht.",
      times: (v) => `Check-in ab ${v.time} Uhr, Check-out bis ${v.until} Uhr.`,
    },
    declined: {
      subject: (v) => `${v.property}: kein Zimmer am ${v.dates}`,
      full: "Leider sind wir in diesen Nächten ausgebucht.",
    },
    expiredQuote: {
      subject: (v) => `Ihr Angebot von ${v.property} ist abgelaufen`,
      body: (v) =>
        `Das Angebot für ${v.dates} wurde nicht rechtzeitig angenommen, die Nächte sind daher nicht mehr reserviert. Schreiben Sie uns, wenn Sie ein neues möchten.`,
    },
    reminder: {
      subject: (v) => `Erinnerung: Ihre Anzahlung für ${v.dates}`,
      body: (v) => `Ihre Anzahlung von ${v.amount} ist bis ${v.until} fällig.`,
    },
    notPaid: {
      subject: (v) => `Ihre Buchung bei ${v.property} wurde nicht abgeschlossen`,
      body: (v) =>
        `Die Anzahlung für ${v.dates} ist nicht rechtzeitig eingegangen, daher wurde die Buchung nicht abgeschlossen und die Nächte sind nicht mehr reserviert.`,
    },
    beforeArrival: {
      subject: (v) => `Bis ${v.weekday} bei ${v.property}`,
      body: (v) =>
        `Check-in ab ${v.time} Uhr.${v.how ? ` ${v.how}` : ""}${v.due ? ` ${v.due}` : ""} Antworten Sie auf diese E-Mail, wenn Sie etwas brauchen.`,
    },
    arrivalDetails: {
      subject: (v) => `Ihre Anreise zu ${v.property}: die Details`,
      body: (v) => `Ihre Anreisedetails für den ${v.date}:\n\n${v.details}`,
    },
    cancelledByProperty: {
      subject: (v) => `${v.property} musste Ihren Aufenthalt stornieren`,
      refund: (v) => `${v.property} erstattet alles, was Sie gezahlt haben: ${v.paid}.`,
    },
    cancelled: {
      subject: (v) => `Ihr Aufenthalt bei ${v.property} ist storniert`,
      body: (v) =>
        `Ihr Aufenthalt vom ${v.dates} ist storniert.${v.fee ? ` Stornogebühr: ${v.fee}.` : ""}${v.refund ? ` ${v.property} erstattet ${v.refund}.` : ""}`,
    },
    changed: {
      subject: (v) => `Ihr Aufenthalt bei ${v.property} wurde geändert: ${v.dates}`,
      body: (v) => `Ihr Aufenthalt ist jetzt vom ${v.dates}. Neuer Gesamtbetrag: ${v.total}.`,
    },
    paymentReceived: {
      subject: (v) => `Zahlung eingegangen: ${v.amount} (${v.ref})`,
      body: (v) => `${v.property} hat Ihre Zahlung von ${v.amount} erhalten.`,
    },
    needsInfo: {
      subject: (v) => `${v.property} hat eine Frage zu Ihrem Aufenthalt`,
      body: (v) => `${v.note ?? ""}`,
    },
    thankYou: {
      subject: (v) => `Danke für Ihren Aufenthalt bei ${v.property}`,
      body: () => "Danke, dass Sie bei uns waren. Wir freuen uns, Sie wieder zu begrüßen.",
    },
  },
  page: {
    accept: "Annehmen und buchen",
    otherDates: "Nach anderen Daten fragen",
    noThanks: "Nein, danke",
    confirmAccept: (v) => `Sie buchen ${v.nights}, ${v.dates}, für ${v.total}.${v.free ? ` ${v.free}` : ""}`,
    book: "Buchen",
    bookAndPay: "Buchen und Anzahlung leisten",
    obligation: "Zahlungspflichtig buchen",
    pay: (v) => `${v.amount} zahlen`,
    payBy: (v) => `Leisten Sie die Anzahlung von ${v.amount} an ${v.property} bis ${v.until}.`,
    card: (v) =>
      `${v.property} bittet um eine Karte zur Garantie Ihrer Buchung. Jetzt wird nichts belastet. Gemäß seinen Bedingungen kann es ein Nichterscheinen oder eine späte Stornierung berechnen.`,
    addCard: "Karte hinzufügen",
    cardSaved: "Ihre Karte garantiert die Buchung.",
    cancelQuestion: (v) => `Aufenthalt stornieren? Es ist nach dem ${v.date}, die Gebühr beträgt daher ${v.fee}.`,
    cancelFree: (v) => `Jetzt stornieren ist kostenlos. ${v.property} erstattet Ihre ${v.paid}.`,
    cancelNothingBack: "Es gibt nichts zu erstatten.",
    cancelRefund: (v) => `Sie haben ${v.paid} gezahlt, ${v.property} erstattet daher ${v.refund}.`,
    cancelMine: "Meinen Aufenthalt stornieren",
    keep: "Behalten",
    newTotal: (v) => `Neuer Gesamtbetrag: ${v.total}`,
    payMore: (v) => `Sie zahlen ${v.more} mehr.`,
    refundLess: (v) => `Wir erstatten ${v.refund}.`,
    askProperty: (v) => `${v.property} fragen`,
    changeMine: "Meine Buchung ändern",
    booked: "Ihre Buchung steht.",
    reference: (v) => `Referenz ${v.ref}`,
    checkIn: (v) => `Check-in ab ${v.time} Uhr`,
    checkOut: (v) => `Check-out bis ${v.time} Uhr`,
    howToFind: "So finden Sie uns",
    status: {
      requested: "Ihre Anfrage ist bei uns",
      needs_info: "Uns fehlt eine Angabe",
      quoted: "Unser Angebot",
      held: "Für Sie reserviert",
      booking: "Wird bestätigt",
      awaiting_payment: "Wartet auf Ihre Anzahlung",
      confirmed: "Gebucht",
      checked_in: "Willkommen",
      completed: "Danke für Ihren Aufenthalt",
      no_show: "Als nicht angereist vermerkt",
      cancelled_by_guest: "Storniert, wie gewünscht",
      cancelled_by_property: "Von uns storniert",
      declined: "Kein Zimmer in diesen Nächten",
      expired: "Nicht mehr offen",
    },
  },
};

const IT: StayCopy = {
  nights: (n) => (n === 1 ? "1 notte" : `${n} notti`),
  adults: (n) => (n === 1 ? "1 adulto" : `${n} adulti`),
  children: (n) => (n === 1 ? "1 bambino" : `${n} bambini`),
  includes: (rate, name) => `include ${rate} di ${name}`,
  paidAtProperty: "(da pagare in struttura)",
  mealFor: (meal, n) => `${meal} per ${n}`,
  schedule: { deposit: "Acconto", balance: "Saldo", atProperty: "In struttura", difference: "Differenza", now: "Ora" },
  from: (nights, date) => `${nights} dal ${date}`,
  purpose: { deposit: "acconto", balance: "saldo", difference: "differenza" },
  with: (v) => `La sua prenotazione è con ${v.property}.`,
  automatic: (v) => `Inviato automaticamente da ${v.property}.`,
  notInvoice: (v) => `Questa è la conferma della prenotazione, non una fattura. ${v.property} emette la sua fattura.`,
  reply: (v) => `Risponda a questa email per scrivere a ${v.property}.`,
  emails: {
    received: {
      subject: (v) => `La sua richiesta a ${v.property}: ${v.dates}`,
      body: (v) =>
        `La sua richiesta per ${v.dates} è arrivata a ${v.property}. ${v.property} risponde entro ${v.hours} ore.`,
    },
    quote: {
      subject: (v) => `Il suo soggiorno presso ${v.property}: ${v.dates}`,
      intro: (v) => `${v.property} può accoglierla.`,
      holds: (v) => `Questo preventivo è valido fino al ${v.until}.`,
    },
    payNow: (v) => `Da pagare ora: ${v.now}. In struttura: ${v.there}.`,
    payParts: (v) => `Da pagare ora: ${v.now}.`,
    confirmed: {
      subject: (v) => `Prenotato: ${v.property}, ${v.dates}`,
      intro: "La prenotazione è fatta.",
      times: (v) => `Check-in dalle ${v.time}, check-out entro le ${v.until}.`,
    },
    declined: {
      subject: (v) => `${v.property}: nessuna camera il ${v.dates}`,
      full: "Ci dispiace, quelle notti siamo al completo.",
    },
    expiredQuote: {
      subject: (v) => `Il suo preventivo di ${v.property} è scaduto`,
      body: (v) =>
        `Il preventivo per ${v.dates} non è stato accettato in tempo, quindi le notti non sono più riservate. Ci scriva se ne desidera un altro.`,
    },
    reminder: {
      subject: (v) => `Promemoria: il suo acconto per ${v.dates}`,
      body: (v) => `Il suo acconto di ${v.amount} è da pagare entro il ${v.until}.`,
    },
    notPaid: {
      subject: (v) => `La sua prenotazione presso ${v.property} non è stata completata`,
      body: (v) =>
        `L'acconto per ${v.dates} non è stato pagato in tempo, quindi la prenotazione non è stata completata e le notti non sono più riservate.`,
    },
    beforeArrival: {
      subject: (v) => `A ${v.weekday} presso ${v.property}`,
      body: (v) =>
        `Check-in dalle ${v.time}.${v.how ? ` ${v.how}` : ""}${v.due ? ` ${v.due}` : ""} Risponda a questa email se le serve qualcosa.`,
    },
    arrivalDetails: {
      subject: (v) => `Arrivo presso ${v.property}: i dettagli`,
      body: (v) => `I dettagli del suo arrivo per il ${v.date}:\n\n${v.details}`,
    },
    cancelledByProperty: {
      subject: (v) => `${v.property} ha dovuto cancellare il suo soggiorno`,
      refund: (v) => `${v.property} le rimborsa tutto quanto pagato: ${v.paid}.`,
    },
    cancelled: {
      subject: (v) => `Il suo soggiorno presso ${v.property} è cancellato`,
      body: (v) =>
        `Il suo soggiorno del ${v.dates} è cancellato.${v.fee ? ` Penale: ${v.fee}.` : ""}${v.refund ? ` ${v.property} le rimborsa ${v.refund}.` : ""}`,
    },
    changed: {
      subject: (v) => `Il suo soggiorno presso ${v.property} è cambiato: ${v.dates}`,
      body: (v) => `Il suo soggiorno è ora del ${v.dates}. Nuovo totale: ${v.total}.`,
    },
    paymentReceived: {
      subject: (v) => `Pagamento ricevuto: ${v.amount} (${v.ref})`,
      body: (v) => `${v.property} ha ricevuto il suo pagamento di ${v.amount}.`,
    },
    needsInfo: {
      subject: (v) => `${v.property} ha una domanda sul suo soggiorno`,
      body: (v) => `${v.note ?? ""}`,
    },
    thankYou: {
      subject: (v) => `Grazie per il soggiorno presso ${v.property}`,
      body: () => "Grazie per aver soggiornato da noi. Speriamo di accoglierla di nuovo.",
    },
  },
  page: {
    accept: "Accetta e prenota",
    otherDates: "Chiedi altre date",
    noThanks: "No, grazie",
    confirmAccept: (v) => `Prenota ${v.nights}, ${v.dates}, per ${v.total}.${v.free ? ` ${v.free}` : ""}`,
    book: "Prenota",
    bookAndPay: "Prenota e paga l'acconto",
    obligation: "Prenota con obbligo di pagamento",
    pay: (v) => `Paga ${v.amount}`,
    payBy: (v) => `Paghi l'acconto di ${v.amount} a ${v.property} entro il ${v.until}.`,
    card: (v) =>
      `${v.property} chiede una carta a garanzia della prenotazione. Ora non viene addebitato nulla. Secondo le sue condizioni può addebitare una mancata presentazione o una cancellazione tardiva.`,
    addCard: "Aggiungi una carta",
    cardSaved: "La sua carta garantisce la prenotazione.",
    cancelQuestion: (v) => `Cancellare il soggiorno? È dopo il ${v.date}, quindi la penale è di ${v.fee}.`,
    cancelFree: (v) => `Cancellare ora è gratuito. ${v.property} le rimborsa i suoi ${v.paid}.`,
    cancelNothingBack: "Non c'è nulla da rimborsare.",
    cancelRefund: (v) => `Ha pagato ${v.paid}, quindi ${v.property} le rimborsa ${v.refund}.`,
    cancelMine: "Cancella il mio soggiorno",
    keep: "Tienilo",
    newTotal: (v) => `Nuovo totale: ${v.total}`,
    payMore: (v) => `Paga ${v.more} in più.`,
    refundLess: (v) => `Le rimborsiamo ${v.refund}.`,
    askProperty: (v) => `Chiedi a ${v.property}`,
    changeMine: "Cambia la mia prenotazione",
    booked: "La prenotazione è fatta.",
    reference: (v) => `Riferimento ${v.ref}`,
    checkIn: (v) => `Check-in dalle ${v.time}`,
    checkOut: (v) => `Check-out entro le ${v.time}`,
    howToFind: "Come trovarci",
    status: {
      requested: "La sua richiesta è da noi",
      needs_info: "Ci serve un dettaglio",
      quoted: "Il nostro preventivo",
      held: "Riservato per lei",
      booking: "In conferma",
      awaiting_payment: "In attesa del suo acconto",
      confirmed: "Prenotato",
      checked_in: "Benvenuto",
      completed: "Grazie del soggiorno",
      no_show: "Registrato come non arrivato",
      cancelled_by_guest: "Cancellato, come chiesto",
      cancelled_by_property: "Cancellato da noi",
      declined: "Nessuna camera quelle notti",
      expired: "Non più aperto",
    },
  },
};

const PT: StayCopy = {
  nights: (n) => `${n} noite${n === 1 ? "" : "s"}`,
  adults: (n) => `${n} adulto${n === 1 ? "" : "s"}`,
  children: (n) => `${n} criança${n === 1 ? "" : "s"}`,
  includes: (rate, name) => `inclui ${rate} de ${name}`,
  paidAtProperty: "(pago no alojamento)",
  mealFor: (meal, n) => `${meal} para ${n}`,
  schedule: {
    deposit: "Sinal",
    balance: "Restante",
    atProperty: "No alojamento",
    difference: "Diferença",
    now: "Agora",
  },
  from: (nights, date) => `${nights} a partir de ${date}`,
  purpose: { deposit: "sinal", balance: "restante", difference: "diferença" },
  with: (v) => `A sua reserva é com ${v.property}.`,
  automatic: (v) => `Enviado automaticamente por ${v.property}.`,
  notInvoice: (v) => `Esta é a confirmação da sua reserva, não uma fatura. ${v.property} emite a sua fatura.`,
  reply: (v) => `Responda a este email para escrever a ${v.property}.`,
  emails: {
    received: {
      subject: (v) => `O seu pedido a ${v.property}: ${v.dates}`,
      body: (v) => `O seu pedido para ${v.dates} chegou a ${v.property}. ${v.property} responde em ${v.hours} horas.`,
    },
    quote: {
      subject: (v) => `A sua estadia em ${v.property}: ${v.dates}`,
      intro: (v) => `${v.property} pode recebê-lo.`,
      holds: (v) => `Esta proposta é válida até ${v.until}.`,
    },
    payNow: (v) => `A pagar agora: ${v.now}. No alojamento: ${v.there}.`,
    payParts: (v) => `A pagar agora: ${v.now}.`,
    confirmed: {
      subject: (v) => `Reservado: ${v.property}, ${v.dates}`,
      intro: "A sua reserva está feita.",
      times: (v) => `Entrada a partir das ${v.time}, saída até às ${v.until}.`,
    },
    declined: {
      subject: (v) => `${v.property}: sem quartos a ${v.dates}`,
      full: "Lamentamos, nessas noites estamos cheios.",
    },
    expiredQuote: {
      subject: (v) => `A sua proposta de ${v.property} expirou`,
      body: (v) =>
        `A proposta para ${v.dates} não foi aceite a tempo, por isso as noites já não estão reservadas. Escreva-nos se quiser outra.`,
    },
    reminder: {
      subject: (v) => `Lembrete: o seu sinal para ${v.dates}`,
      body: (v) => `O seu sinal de ${v.amount} deve ser pago até ${v.until}.`,
    },
    notPaid: {
      subject: (v) => `A sua reserva em ${v.property} não foi concluída`,
      body: (v) =>
        `O sinal para ${v.dates} não foi pago a tempo, por isso a reserva não foi concluída e as noites já não estão reservadas.`,
    },
    beforeArrival: {
      subject: (v) => `Até ${v.weekday} em ${v.property}`,
      body: (v) =>
        `Entrada a partir das ${v.time}.${v.how ? ` ${v.how}` : ""}${v.due ? ` ${v.due}` : ""} Responda a este email se precisar de alguma coisa.`,
    },
    arrivalDetails: {
      subject: (v) => `Chegada a ${v.property}: os seus detalhes`,
      body: (v) => `Os seus detalhes de chegada para ${v.date}:\n\n${v.details}`,
    },
    cancelledByProperty: {
      subject: (v) => `${v.property} teve de cancelar a sua estadia`,
      refund: (v) => `${v.property} devolve tudo o que pagou: ${v.paid}.`,
    },
    cancelled: {
      subject: (v) => `A sua estadia em ${v.property} está cancelada`,
      body: (v) =>
        `A sua estadia de ${v.dates} está cancelada.${v.fee ? ` Taxa de cancelamento: ${v.fee}.` : ""}${v.refund ? ` ${v.property} devolve ${v.refund}.` : ""}`,
    },
    changed: {
      subject: (v) => `A sua estadia em ${v.property} foi alterada: ${v.dates}`,
      body: (v) => `A sua estadia é agora de ${v.dates}. Novo total: ${v.total}.`,
    },
    paymentReceived: {
      subject: (v) => `Pagamento recebido: ${v.amount} (${v.ref})`,
      body: (v) => `${v.property} recebeu o seu pagamento de ${v.amount}.`,
    },
    needsInfo: {
      subject: (v) => `${v.property} tem uma pergunta sobre a sua estadia`,
      body: (v) => `${v.note ?? ""}`,
    },
    thankYou: {
      subject: (v) => `Obrigado pela sua estadia em ${v.property}`,
      body: () => "Obrigado por ter ficado connosco. Esperamos voltar a recebê-lo.",
    },
  },
  page: {
    accept: "Aceitar e reservar",
    otherDates: "Pedir outras datas",
    noThanks: "Não, obrigado",
    confirmAccept: (v) => `Vai reservar ${v.nights}, ${v.dates}, por ${v.total}.${v.free ? ` ${v.free}` : ""}`,
    book: "Reservar",
    bookAndPay: "Reservar e pagar o sinal",
    obligation: "Reservar com obrigação de pagamento",
    pay: (v) => `Pagar ${v.amount}`,
    payBy: (v) => `Pague o sinal de ${v.amount} a ${v.property} até ${v.until}.`,
    card: (v) =>
      `${v.property} pede um cartão para garantir a sua reserva. Nada é cobrado agora. Segundo a sua política, pode cobrar uma não comparência ou um cancelamento tardio.`,
    addCard: "Adicionar um cartão",
    cardSaved: "O seu cartão garante a reserva.",
    cancelQuestion: (v) => `Cancelar a sua estadia? Já passou ${v.date}, por isso a taxa é ${v.fee}.`,
    cancelFree: (v) => `Cancelar agora é grátis. ${v.property} devolve os seus ${v.paid}.`,
    cancelNothingBack: "Não há nada a devolver.",
    cancelRefund: (v) => `Pagou ${v.paid}, por isso ${v.property} devolve ${v.refund}.`,
    cancelMine: "Cancelar a minha estadia",
    keep: "Manter",
    newTotal: (v) => `Novo total: ${v.total}`,
    payMore: (v) => `Paga mais ${v.more}.`,
    refundLess: (v) => `Devolvemos ${v.refund}.`,
    askProperty: (v) => `Perguntar a ${v.property}`,
    changeMine: "Alterar a minha reserva",
    booked: "A sua reserva está feita.",
    reference: (v) => `Referência ${v.ref}`,
    checkIn: (v) => `Entrada a partir das ${v.time}`,
    checkOut: (v) => `Saída até às ${v.time}`,
    howToFind: "Como chegar",
    status: {
      requested: "O seu pedido está connosco",
      needs_info: "Precisamos de um detalhe",
      quoted: "A nossa proposta",
      held: "Reservado para si",
      booking: "A confirmar",
      awaiting_payment: "À espera do seu sinal",
      confirmed: "Reservado",
      checked_in: "Bem-vindo",
      completed: "Obrigado pela estadia",
      no_show: "Registado como não chegou",
      cancelled_by_guest: "Cancelada, como pediu",
      cancelled_by_property: "Cancelada por nós",
      declined: "Sem quartos nessas noites",
      expired: "Já não está aberta",
    },
  },
};

export const STAY_COPY: Readonly<Record<StayLang, StayCopy>> = { en: EN, es: ES, fr: FR, de: DE, it: IT, pt: PT };

/** The guest copy for a language tag: its own of the six, else English. */
export function stayCopy(tag: string | null | undefined): StayCopy {
  return STAY_COPY[stayLang(tag)];
}

/** A word of `vocab/lodging.json` in a language, else its English, else the token itself. */
export function lodgingWord(
  group: "kinds" | "beds" | "amenities" | "meals" | "house_rules" | "fee_bases" | "extras",
  token: string,
  lang: StayLang,
): string {
  const entry = LODGING_VOCABULARY[group][token];
  return entry?.[lang] ?? entry?.en ?? token;
}

/** Every guest-facing string a language's copy can produce, filled with sample values: what the copy lint reads. */
export function sampleStayStrings(lang: StayLang): Record<string, string> {
  const c = STAY_COPY[lang];
  const v: StayVars = {
    property: "Ryokan Hoshi",
    dates: "12–15 Dec",
    nights: c.nights(3),
    guests: c.adults(2),
    total: "¥90,540",
    amount: "¥25,800",
    now: "¥25,800",
    there: "¥64,740",
    until: "13 Nov, 10:00",
    ref: "4F2K9Q",
    date: "9 Dec",
    time: "15:00",
    weekday: "Saturday",
    fee: "¥25,800",
    paid: "¥25,800",
    refund: "¥12,900",
    more: "¥5,660",
    hours: "12",
    note: "We have one room left.",
    how: "From the station, take exit 3.",
    due: "¥64,740 to pay at the property.",
    details: "Door code 4471, wifi Hoshi-Guest.",
    free: "Free cancellation until 9 Dec.",
  };
  const out: Record<string, string> = {};
  const walk = (prefix: string, node: unknown) => {
    if (typeof node === "string") out[prefix] = node;
    else if (typeof node === "function") {
      const fn = node as (...a: unknown[]) => unknown;
      const r =
        fn.length >= 2
          ? fn("10%", "VAT")
          : fn.length === 1 && /nights|adults|children|mealFor/.test(prefix)
            ? fn(2)
            : fn(v);
      if (typeof r === "string") out[prefix] = r;
    } else if (node && typeof node === "object") {
      for (const [k, x] of Object.entries(node)) walk(prefix ? `${prefix}.${k}` : k, x);
    }
  };
  walk("", c);
  return out;
}
