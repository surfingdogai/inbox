import { type PolicyLang, policyLang } from "../policy/words";

/**
 * What a salon's customers read about staff, add-ons, deposits and what comes first (ADR-035), in the
 * business's voice and the six template languages; any other reads in English. Never the software,
 * a network, records or anyone else's history: the customer copy lint holds every line to that.
 */
export interface StaffWords {
  readonly withStaff: (name: string) => string;
  readonly addOns: (names: string) => string;
  readonly deposit: (amount: string, when: string) => string;
  readonly depositNow: (amount: string) => string;
  /** The service must come after another one here, within some days: book that one first. */
  readonly first: (service: string, first: string, days: number) => string;
  /** We could not tell it was done: we will check, and confirm. */
  readonly check: (service: string, first: string, days: number) => string;
  readonly cancelFee: (fee: string) => string;
  readonly cancelFeeBack: (fee: string, back: string) => string;
  readonly cancelFree: string;
  readonly anyone: string;
}

const WORDS: Readonly<Record<PolicyLang, StaffWords>> = {
  en: {
    withStaff: (n) => `With ${n}.`,
    addOns: (a) => `Added: ${a}.`,
    deposit: (a, w) => `A deposit of ${a} keeps it: please pay it by ${w}.`,
    depositNow: (a) => `A deposit of ${a} keeps it.`,
    first: (s, f, d) => `${s} starts with ${f} here, within ${d} days before. Book ${f} first, and then ${s} after it.`,
    check: (s, f, d) => `${s} starts with ${f} here, within ${d} days before. We will check and confirm your booking.`,
    cancelFee: (f) => `Cancelling now costs ${f}.`,
    cancelFeeBack: (f, b) => `Cancelling now costs ${f}; ${b} comes back to you.`,
    cancelFree: "Cancelling now is free.",
    anyone: "Anyone free",
  },
  es: {
    withStaff: (n) => `Con ${n}.`,
    addOns: (a) => `Añadido: ${a}.`,
    deposit: (a, w) => `Un depósito de ${a} la reserva: págalo antes del ${w}.`,
    depositNow: (a) => `Un depósito de ${a} la reserva.`,
    first: (s, f, d) => `${s} empieza aquí con ${f}, como mucho ${d} días antes. Reserva primero ${f} y después ${s}.`,
    check: (s, f, d) =>
      `${s} empieza aquí con ${f}, como mucho ${d} días antes. Lo comprobaremos y confirmaremos tu reserva.`,
    cancelFee: (f) => `Cancelar ahora cuesta ${f}.`,
    cancelFeeBack: (f, b) => `Cancelar ahora cuesta ${f}; te devolvemos ${b}.`,
    cancelFree: "Cancelar ahora es gratis.",
    anyone: "Cualquiera libre",
  },
  fr: {
    withStaff: (n) => `Avec ${n}.`,
    addOns: (a) => `Ajouté : ${a}.`,
    deposit: (a, w) => `Un acompte de ${a} le garde : merci de le régler avant le ${w}.`,
    depositNow: (a) => `Un acompte de ${a} le garde.`,
    first: (s, f, d) => `${s} commence ici par ${f}, au plus ${d} jours avant. Réservez d'abord ${f}, puis ${s}.`,
    check: (s, f, d) =>
      `${s} commence ici par ${f}, au plus ${d} jours avant. Nous vérifions et confirmons votre rendez-vous.`,
    cancelFee: (f) => `Annuler maintenant coûte ${f}.`,
    cancelFeeBack: (f, b) => `Annuler maintenant coûte ${f} ; ${b} vous est rendu.`,
    cancelFree: "Annuler maintenant est gratuit.",
    anyone: "La première personne libre",
  },
  de: {
    withStaff: (n) => `Bei ${n}.`,
    addOns: (a) => `Dazu: ${a}.`,
    deposit: (a, w) => `Eine Anzahlung von ${a} hält den Termin: bitte bis ${w} zahlen.`,
    depositNow: (a) => `Eine Anzahlung von ${a} hält den Termin.`,
    first: (s, f, d) =>
      `${s} beginnt bei uns mit ${f}, höchstens ${d} Tage vorher. Buchen Sie zuerst ${f} und danach ${s}.`,
    check: (s, f, d) =>
      `${s} beginnt bei uns mit ${f}, höchstens ${d} Tage vorher. Wir prüfen das und bestätigen Ihren Termin.`,
    cancelFee: (f) => `Jetzt abzusagen kostet ${f}.`,
    cancelFeeBack: (f, b) => `Jetzt abzusagen kostet ${f}; ${b} bekommen Sie zurück.`,
    cancelFree: "Jetzt abzusagen kostet nichts.",
    anyone: "Wer frei ist",
  },
  it: {
    withStaff: (n) => `Con ${n}.`,
    addOns: (a) => `In più: ${a}.`,
    deposit: (a, w) => `Un acconto di ${a} lo tiene: pagalo entro il ${w}.`,
    depositNow: (a) => `Un acconto di ${a} lo tiene.`,
    first: (s, f, d) => `${s} qui comincia con ${f}, al massimo ${d} giorni prima. Prenota prima ${f}, poi ${s}.`,
    check: (s, f, d) =>
      `${s} qui comincia con ${f}, al massimo ${d} giorni prima. Controlliamo e confermiamo la prenotazione.`,
    cancelFee: (f) => `Annullare ora costa ${f}.`,
    cancelFeeBack: (f, b) => `Annullare ora costa ${f}; ti restituiamo ${b}.`,
    cancelFree: "Annullare ora è gratuito.",
    anyone: "Chiunque sia libero",
  },
  pt: {
    withStaff: (n) => `Com ${n}.`,
    addOns: (a) => `Acrescentado: ${a}.`,
    deposit: (a, w) => `Um sinal de ${a} garante a marcação: pague-o até ${w}.`,
    depositNow: (a) => `Um sinal de ${a} garante a marcação.`,
    first: (s, f, d) => `${s} começa aqui com ${f}, no máximo ${d} dias antes. Marque primeiro ${f} e depois ${s}.`,
    check: (s, f, d) =>
      `${s} começa aqui com ${f}, no máximo ${d} dias antes. Vamos verificar e confirmar a sua marcação.`,
    cancelFee: (f) => `Cancelar agora custa ${f}.`,
    cancelFeeBack: (f, b) => `Cancelar agora custa ${f}; ${b} é-lhe devolvido.`,
    cancelFree: "Cancelar agora não custa nada.",
    anyone: "Quem estiver livre",
  },
};

export function staffWords(lang: string | null | undefined): StaffWords {
  return WORDS[policyLang(lang)];
}

/** Every customer line of every language, for the customer copy lint. */
export function everyStaffLine(): string[] {
  const out: string[] = [];
  for (const w of Object.values(WORDS)) {
    out.push(
      w.withStaff("Mei"),
      w.addOns("Blow-dry"),
      w.deposit("CA$20.00", "4 Nov, 18:00"),
      w.depositNow("₩10,000"),
      w.first("Colour", "Patch test", 180),
      w.check("Colour", "Patch test", 180),
      w.cancelFee("₦5,000"),
      w.cancelFeeBack("₦5,000", "₦10,000"),
      w.cancelFree,
      w.anyone,
    );
  }
  return out;
}
