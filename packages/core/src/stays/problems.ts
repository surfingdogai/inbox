import { type StayLang, stayLang } from "./copy";

/**
 * Why a guest's step on a stay did not go through, in their language (ADR-033 §12): what a guest's
 * assistant or the guest's own page reads. In the property's voice, never the inbox's, and never a
 * word from the customer copy lint. The owner and the owner's AI read the English reasons the write
 * gives them instead.
 */
export interface StayProblems {
  readonly nightsTaken: string;
  readonly quoteLapsed: (until: string) => string;
  readonly noQuote: string;
  readonly holdLapsed: string;
  readonly started: string;
  readonly confirmTerms: string;
  readonly confirmFee: string;
  readonly tooMany: (room: string) => string;
  readonly closed: string;
  readonly onRequest: (hours: number) => string;
  readonly noChange: string;
  readonly changeLapsed: string;
}

const EN: StayProblems = {
  nightsTaken: "Those nights are no longer free.",
  quoteLapsed: (until) => `This quote could be accepted until ${until}. Ask again for these dates.`,
  noQuote: "There is no quote to accept on this stay yet.",
  holdLapsed: "The hold on these rooms has ended. Check what is free again.",
  started: "This stay has started, so it can no longer change online. Reply to reach the property.",
  confirmTerms: "Please confirm the total, the payments and the cancellation terms first.",
  confirmFee: "Please confirm the cancellation fee first.",
  tooMany: (room) => `${room} does not sleep that many guests.`,
  closed: "The property is closed on some of those nights.",
  onRequest: (h) => `On request. The property answers within ${h} hours.`,
  noChange: "There is no change to answer on this stay.",
  changeLapsed: "That change can no longer be accepted. Ask for it again if it still suits you.",
};

const ES: StayProblems = {
  nightsTaken: "Esas noches ya no están libres.",
  quoteLapsed: (until) => `Este presupuesto se podía aceptar hasta ${until}. Vuelva a pedirlo para estas fechas.`,
  noQuote: "Todavía no hay un presupuesto que aceptar para esta estancia.",
  holdLapsed: "La reserva provisional de estas habitaciones ha terminado. Compruebe de nuevo qué está libre.",
  started: "La estancia ya ha empezado y no se puede cambiar en línea. Responda para hablar con el alojamiento.",
  confirmTerms: "Confirme primero el total, los pagos y las condiciones de cancelación.",
  confirmFee: "Confirme primero el cargo por cancelación.",
  tooMany: (room) => `${room} no admite tantos huéspedes.`,
  closed: "El alojamiento está cerrado alguna de esas noches.",
  onRequest: (h) => `Bajo petición. El alojamiento responde en un máximo de ${h} horas.`,
  noChange: "No hay ningún cambio que responder en esta estancia.",
  changeLapsed: "Ese cambio ya no se puede aceptar. Vuelva a pedirlo si todavía le conviene.",
};

const FR: StayProblems = {
  nightsTaken: "Ces nuits ne sont plus libres.",
  quoteLapsed: (until) => `Ce devis pouvait être accepté jusqu'au ${until}. Redemandez-le pour ces dates.`,
  noQuote: "Il n'y a pas encore de devis à accepter pour ce séjour.",
  holdLapsed: "La mise de côté de ces chambres a pris fin. Vérifiez à nouveau ce qui est libre.",
  started: "Le séjour a commencé et ne peut plus être modifié en ligne. Répondez pour joindre l'établissement.",
  confirmTerms: "Merci de confirmer d'abord le total, les paiements et les conditions d'annulation.",
  confirmFee: "Merci de confirmer d'abord les frais d'annulation.",
  tooMany: (room) => `${room} n'accueille pas autant de personnes.`,
  closed: "L'établissement est fermé certaines de ces nuits.",
  onRequest: (h) => `Sur demande. L'établissement répond sous ${h} heures.`,
  noChange: "Il n'y a aucune modification à laquelle répondre pour ce séjour.",
  changeLapsed: "Cette modification ne peut plus être acceptée. Redemandez-la si elle vous convient toujours.",
};

const DE: StayProblems = {
  nightsTaken: "Diese Nächte sind nicht mehr frei.",
  quoteLapsed: (until) => `Dieses Angebot galt bis ${until}. Fragen Sie für diese Daten bitte erneut an.`,
  noQuote: "Für diesen Aufenthalt gibt es noch kein Angebot zum Annehmen.",
  holdLapsed: "Die Reservierung dieser Zimmer ist abgelaufen. Prüfen Sie bitte erneut, was frei ist.",
  started:
    "Der Aufenthalt hat begonnen und lässt sich online nicht mehr ändern. Antworten Sie, um die Unterkunft zu erreichen.",
  confirmTerms: "Bitte bestätigen Sie zuerst den Gesamtpreis, die Zahlungen und die Stornobedingungen.",
  confirmFee: "Bitte bestätigen Sie zuerst die Stornogebühr.",
  tooMany: (room) => `${room} bietet nicht so vielen Gästen Platz.`,
  closed: "Die Unterkunft ist in einigen dieser Nächte geschlossen.",
  onRequest: (h) => `Auf Anfrage. Die Unterkunft antwortet innerhalb von ${h} Stunden.`,
  noChange: "Zu diesem Aufenthalt gibt es keine Änderung zu beantworten.",
  changeLapsed: "Diese Änderung kann nicht mehr angenommen werden. Fragen Sie erneut, wenn sie noch passt.",
};

const IT: StayProblems = {
  nightsTaken: "Quelle notti non sono più libere.",
  quoteLapsed: (until) =>
    `Questo preventivo si poteva accettare fino al ${until}. Richiedilo di nuovo per queste date.`,
  noQuote: "Non c'è ancora un preventivo da accettare per questo soggiorno.",
  holdLapsed: "Il blocco di queste camere è scaduto. Controlla di nuovo cosa è libero.",
  started: "Il soggiorno è iniziato e non si può più modificare online. Rispondi per contattare la struttura.",
  confirmTerms: "Conferma prima il totale, i pagamenti e le condizioni di cancellazione.",
  confirmFee: "Conferma prima la penale di cancellazione.",
  tooMany: (room) => `${room} non ospita così tante persone.`,
  closed: "La struttura è chiusa in alcune di quelle notti.",
  onRequest: (h) => `Su richiesta. La struttura risponde entro ${h} ore.`,
  noChange: "Non c'è nessuna modifica a cui rispondere per questo soggiorno.",
  changeLapsed: "Quella modifica non si può più accettare. Richiedila se ti va ancora bene.",
};

const PT: StayProblems = {
  nightsTaken: "Essas noites já não estão livres.",
  quoteLapsed: (until) => `Este orçamento podia ser aceite até ${until}. Peça de novo para estas datas.`,
  noQuote: "Ainda não há um orçamento para aceitar nesta estadia.",
  holdLapsed: "A reserva provisória destes quartos terminou. Veja de novo o que está livre.",
  started: "A estadia já começou e não pode ser alterada online. Responda para falar com o alojamento.",
  confirmTerms: "Confirme primeiro o total, os pagamentos e as condições de cancelamento.",
  confirmFee: "Confirme primeiro a taxa de cancelamento.",
  tooMany: (room) => `${room} não aloja tantos hóspedes.`,
  closed: "O alojamento está fechado em algumas dessas noites.",
  onRequest: (h) => `Sob pedido. O alojamento responde em até ${h} horas.`,
  noChange: "Não há nenhuma alteração a que responder nesta estadia.",
  changeLapsed: "Essa alteração já não pode ser aceite. Peça-a de novo se ainda lhe convier.",
};

export const STAY_PROBLEMS: Readonly<Record<StayLang, StayProblems>> = {
  en: EN,
  es: ES,
  fr: FR,
  de: DE,
  it: IT,
  pt: PT,
};

export function stayProblems(tag: string | null | undefined): StayProblems {
  return STAY_PROBLEMS[stayLang(tag)];
}

/** Every problem string in a language, for the customer copy lint. */
export function sampleProblemStrings(lang: StayLang): string[] {
  const p = STAY_PROBLEMS[lang];
  return [
    p.nightsTaken,
    p.quoteLapsed("12 Dec"),
    p.noQuote,
    p.holdLapsed,
    p.started,
    p.confirmTerms,
    p.confirmFee,
    p.tooMany("Double room"),
    p.closed,
    p.onRequest(12),
    p.noChange,
    p.changeLapsed,
  ];
}
