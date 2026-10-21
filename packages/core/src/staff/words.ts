import { type PolicyLang, policyLang } from "../policy/words";

/**
 * What a salon's customers read about staff, add-ons, deposits and what comes first (ADR-035), in the
 * business's voice and the six template languages; any other reads in English. Never the software,
 * a network, records or anyone else's history: the customer copy lint holds every line to that.
 */
export interface StaffWords {
  readonly withStaff: (name: string) => string;
  /** Asked for anyone, with nobody free yet: nobody is named before it binds. */
  readonly withAnyone: string;
  readonly addOns: (names: string) => string;
  readonly deposit: (amount: string, when: string) => string;
  readonly depositNow: (amount: string) => string;
  /** The service must come after another one here, within some days and some hours before: book that one first. */
  readonly first: (service: string, first: string, days: number, hours: number) => string;
  /** We could not tell it was done: we will check, and confirm. */
  readonly check: (service: string, first: string, days: number, hours: number) => string;
  readonly cancelFee: (fee: string) => string;
  readonly cancelFeeBack: (fee: string, back: string) => string;
  readonly cancelFree: string;
  readonly anyone: string;
}

/** When what comes first must be: between so many days and hours before, or in the days before. */
const SPAN: Readonly<Record<PolicyLang, (days: number, hours: number) => string>> = {
  en: (d, h) => (h > 0 ? `between ${d} days and ${h} hours before` : `in the ${d} days before`),
  es: (d, h) => (h > 0 ? `entre ${d} días y ${h} horas antes` : `en los ${d} días anteriores`),
  fr: (d, h) => (h > 0 ? `entre ${d} jours et ${h} heures avant` : `dans les ${d} jours avant`),
  de: (d, h) => (h > 0 ? `zwischen ${d} Tagen und ${h} Stunden vorher` : `in den ${d} Tagen davor`),
  it: (d, h) => (h > 0 ? `tra ${d} giorni e ${h} ore prima` : `nei ${d} giorni prima`),
  pt: (d, h) => (h > 0 ? `entre ${d} dias e ${h} horas antes` : `nos ${d} dias anteriores`),
};

const WORDS: Readonly<Record<PolicyLang, StaffWords>> = {
  en: {
    withStaff: (n) => `With ${n}.`,
    withAnyone: "With whoever is free.",
    addOns: (a) => `Added: ${a}.`,
    deposit: (a, w) => `A deposit of ${a} holds your booking: please pay it by ${w}.`,
    depositNow: (a) => `A deposit of ${a} holds your booking.`,
    first: (s, f, d, h) => `${s} needs ${f} here ${SPAN.en(d, h)}. Please book ${f} first.`,
    check: (s, f, d, h) => `${s} needs ${f} here ${SPAN.en(d, h)}. We will check and confirm your booking.`,
    cancelFee: (f) => `Cancelling now costs ${f}.`,
    cancelFeeBack: (f, b) => `Cancelling now costs ${f}; ${b} comes back to you.`,
    cancelFree: "Cancelling now is free.",
    anyone: "Anyone free",
  },
  es: {
    withStaff: (n) => `Con ${n}.`,
    withAnyone: "Con quien esté libre.",
    addOns: (a) => `Añadido: ${a}.`,
    deposit: (a, w) => `Un depósito de ${a} asegura tu reserva: págalo antes del ${w}.`,
    depositNow: (a) => `Un depósito de ${a} asegura tu reserva.`,
    first: (s, f, d, h) => `${s} necesita ${f} aquí ${SPAN.es(d, h)}. Reserva primero ${f}.`,
    check: (s, f, d, h) => `${s} necesita ${f} aquí ${SPAN.es(d, h)}. Lo comprobaremos y confirmaremos tu reserva.`,
    cancelFee: (f) => `Cancelar ahora cuesta ${f}.`,
    cancelFeeBack: (f, b) => `Cancelar ahora cuesta ${f}; te devolvemos ${b}.`,
    cancelFree: "Cancelar ahora es gratis.",
    anyone: "Cualquiera libre",
  },
  fr: {
    withStaff: (n) => `Avec ${n}.`,
    withAnyone: "Avec la première personne libre.",
    addOns: (a) => `Ajouté : ${a}.`,
    deposit: (a, w) => `Un acompte de ${a} confirme votre rendez-vous : merci de le régler avant le ${w}.`,
    depositNow: (a) => `Un acompte de ${a} confirme votre rendez-vous.`,
    first: (s, f, d, h) => `${s} demande ${f} ici ${SPAN.fr(d, h)}. Réservez d'abord ${f}.`,
    check: (s, f, d, h) => `${s} demande ${f} ici ${SPAN.fr(d, h)}. Nous vérifions et confirmons votre rendez-vous.`,
    cancelFee: (f) => `Annuler maintenant coûte ${f}.`,
    cancelFeeBack: (f, b) => `Annuler maintenant coûte ${f} ; ${b} vous est rendu.`,
    cancelFree: "Annuler maintenant est gratuit.",
    anyone: "La première personne libre",
  },
  de: {
    withStaff: (n) => `Bei ${n}.`,
    withAnyone: "Bei der Person, die dann frei ist.",
    addOns: (a) => `Dazu: ${a}.`,
    deposit: (a, w) => `Eine Anzahlung von ${a} sichert den Termin: bitte bis ${w} zahlen.`,
    depositNow: (a) => `Eine Anzahlung von ${a} sichert den Termin.`,
    first: (s, f, d, h) => `${s} setzt bei uns ${f} voraus, ${SPAN.de(d, h)}. Buchen Sie zuerst ${f}.`,
    check: (s, f, d, h) =>
      `${s} setzt bei uns ${f} voraus, ${SPAN.de(d, h)}. Wir prüfen das und bestätigen Ihren Termin.`,
    cancelFee: (f) => `Jetzt abzusagen kostet ${f}.`,
    cancelFeeBack: (f, b) => `Jetzt abzusagen kostet ${f}; ${b} bekommen Sie zurück.`,
    cancelFree: "Jetzt abzusagen kostet nichts.",
    anyone: "Wer frei ist",
  },
  it: {
    withStaff: (n) => `Con ${n}.`,
    withAnyone: "Con chi è libero.",
    addOns: (a) => `In più: ${a}.`,
    deposit: (a, w) => `Un acconto di ${a} conferma la prenotazione: pagalo entro il ${w}.`,
    depositNow: (a) => `Un acconto di ${a} conferma la prenotazione.`,
    first: (s, f, d, h) => `${s} richiede qui ${f} ${SPAN.it(d, h)}. Prenota prima ${f}.`,
    check: (s, f, d, h) => `${s} richiede qui ${f} ${SPAN.it(d, h)}. Controlliamo e confermiamo la prenotazione.`,
    cancelFee: (f) => `Annullare ora costa ${f}.`,
    cancelFeeBack: (f, b) => `Annullare ora costa ${f}; ti restituiamo ${b}.`,
    cancelFree: "Annullare ora è gratuito.",
    anyone: "Chiunque sia libero",
  },
  // Words that read the same in Portugal and in Brazil.
  pt: {
    withStaff: (n) => `Com ${n}.`,
    withAnyone: "Com quem estiver livre.",
    addOns: (a) => `Acrescentado: ${a}.`,
    deposit: (a, w) => `Um sinal de ${a} garante a sua reserva: pague-o até ${w}.`,
    depositNow: (a) => `Um sinal de ${a} garante a sua reserva.`,
    first: (s, f, d, h) => `${s} precisa de ${f} aqui ${SPAN.pt(d, h)}. Reserve primeiro ${f}.`,
    check: (s, f, d, h) => `${s} precisa de ${f} aqui ${SPAN.pt(d, h)}. Vamos verificar e confirmar a sua reserva.`,
    cancelFee: (f) => `Cancelar agora custa ${f}.`,
    cancelFeeBack: (f, b) => `Cancelar agora custa ${f}; devolvemos ${b}.`,
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
      w.withAnyone,
      w.addOns("Blow-dry"),
      w.deposit("CA$20.00", "4 Nov, 18:00"),
      w.depositNow("₩10,000"),
      w.first("Colour", "Patch test", 180, 48),
      w.check("Colour", "Patch test", 180, 48),
      w.first("Treatment", "Consultation", 30, 0),
      w.cancelFee("₦5,000"),
      w.cancelFeeBack("₦5,000", "₦10,000"),
      w.cancelFree,
      w.anyone,
    );
  }
  return out;
}
