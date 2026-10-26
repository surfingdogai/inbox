import { formatMinor } from "../util/money";

/**
 * What a kitchen tells a customer's agent (ADR-040), in the business's name and voice, in English,
 * Spanish, French, German, Italian, Portuguese or Japanese: why an order cannot be taken as it is, and
 * what to do instead. Never the software's name, a network or a receipt (the copy lint holds these to it).
 */

export type KitchenLang = "en" | "es" | "fr" | "de" | "it" | "pt" | "ja";
type Method = "pickup" | "delivery" | "dine_in";

const LOCALES: Record<KitchenLang, string> = {
  en: "en-GB",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  it: "it-IT",
  pt: "pt-PT",
  ja: "ja-JP",
};

export function kitchenLang(tag: string | null | undefined): KitchenLang {
  const short = (tag ?? "en").toLowerCase().slice(0, 2);
  return (short in LOCALES ? short : "en") as KitchenLang;
}

/** An amount as the business writes it in a language: `₩18,000`, `1.250 ¥`. */
export function kitchenMoney(
  m: { readonly value: number; readonly currency: string },
  tag: string | null | undefined,
): string {
  return formatMinor(m, LOCALES[kitchenLang(tag)]);
}

function clock(ms: number, zone: string, lang: KitchenLang): string {
  try {
    return new Intl.DateTimeFormat(LOCALES[lang], {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

function dayAndClock(ms: number, zone: string, lang: KitchenLang): string {
  try {
    return new Intl.DateTimeFormat(LOCALES[lang], {
      timeZone: zone,
      weekday: "long",
      day: "numeric",
      month: "long",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms));
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }
}

export interface Words {
  readonly notForATime: string;
  chooseMethod(methods: readonly Method[]): string;
  readonly noTips: string;
  readonly chooseSlot: string;
  paused(until: number, zone: string): string;
  readonly notASlot: string;
  tooSoon(earliest: number, zone: string, notice: boolean): string;
  tooFar(days: number): string;
  slotFull(next: readonly number[], zone: string): string;
  soldOut(name: string): string;
  /** Off sale: the business took it off for now. */
  notAvailable(name: string): string;
  notThatDay(name: string): string;
  notServedThen(name: string): string;
  readonly noDeliveryThere: string;
  belowMinimum(zone: string, minimum: { value: number; currency: string }): string;
  fulfilLine(method: Method, at: number | null, zone: string): string;
  feeLine(zone: string, fee: string): string;
  tipLine(tip: string): string;
  /** list_order_slots: what to tell the person. */
  slotsOpen(n: number, first: number, zone: string): string;
  readonly closedThatDay: string;
  readonly noDelivery: string;
  readonly addressUnknown: string;
  /** The business takes its orders on its own site (doors elsewhere): where. */
  takenElsewhere(url: string): string;
  tableQuote(size: number): string;
  tableTooLarge(max: number): string;
}

const METHOD: Record<KitchenLang, Record<Method, string>> = {
  en: { pickup: "collection", delivery: "delivery", dine_in: "eating in" },
  es: { pickup: "recogida", delivery: "entrega a domicilio", dine_in: "comer aquí" },
  fr: { pickup: "à emporter", delivery: "livraison", dine_in: "sur place" },
  de: { pickup: "Abholung", delivery: "Lieferung", dine_in: "vor Ort essen" },
  it: { pickup: "ritiro", delivery: "consegna", dine_in: "al tavolo" },
  pt: { pickup: "levantamento", delivery: "entrega", dine_in: "comer cá" },
  ja: { pickup: "お持ち帰り", delivery: "配達", dine_in: "店内でのお食事" },
};

/** The words of one business in one language. */
export function kitchenWords(tag: string | null | undefined, business: string): Words {
  const lang = kitchenLang(tag);
  const b = business.trim() || "We";
  const m = (x: readonly Method[]) => x.map((k) => METHOD[lang][k]).join(", ");
  const money = (v: { value: number; currency: string }) => formatMinor(v, LOCALES[lang]);
  const times = (next: readonly number[], zone: string) => next.map((n) => clock(n, zone, lang)).join(", ");
  switch (lang) {
    case "es":
      return {
        notForATime: `${b} no acepta pedidos para una hora concreta: haz el pedido sin hora.`,
        chooseMethod: (x) =>
          x.length ? `${b} acepta pedidos para: ${m(x)}. Elige uno en fulfil.method.` : `${b} no acepta pedidos ahora.`,
        noTips: `${b} no acepta propinas en línea.`,
        chooseSlot: "Elige una franja de list_order_slots (fulfil.slot.start).",
        paused: (u, z) => `${b} no acepta pedidos hasta las ${clock(u, z, lang)}.`,
        notASlot: "Esa hora no es una franja de la cocina: elige una de list_order_slots.",
        tooSoon: (e, z, n) =>
          `${n ? "Este pedido necesita antelación" : "La cocina necesita tiempo"}: la primera franja posible es ${dayAndClock(e, z, lang)}.`,
        tooFar: (d) => `${b} acepta pedidos con hasta ${d} días de antelación.`,
        slotFull: (n, z) =>
          n.length
            ? `Esa franja está completa. Quedan: ${times(n, z)}.`
            : "Esa franja está completa y no quedan más ese día.",
        soldOut: (n) => `${n} está agotado hoy.`,
        notAvailable: (n) => `${n} no está a la venta ahora.`,
        notThatDay: (n) => `${n} no se hace ese día.`,
        notServedThen: (n) => `${n} no se sirve a esa hora.`,
        noDeliveryThere: `${b} no entrega en esa dirección: elige recogida, o otra dirección.`,
        belowMinimum: (z, min) => `El pedido mínimo para entrega en ${z} es ${money(min)}.`,
        fulfilLine: (x, at, z) => `${METHOD[lang][x]}${at !== null ? `: ${dayAndClock(at, z, lang)}` : ""}`,
        feeLine: (z, f) => `Entrega${z ? ` (${z})` : ""}: ${f}`,
        tipLine: (t) => `Propina: ${t}`,
        slotsOpen: (n, f, z) => `${n} franjas libres; la primera, ${dayAndClock(f, z, lang)}.`,
        closedThatDay: `${b} no acepta pedidos ese día.`,
        noDelivery: `${b} no hace entregas.`,
        addressUnknown: `${b} no puede situar esa dirección: envía su código postal y país, o su punto; si no, ${b} decide.`,
        takenElsewhere: (u) => `${b} acepta pedidos en ${u}, no aquí.`,
        tableQuote: (s) => `Para ${s} personas, ${b} prepara una propuesta: queda como solicitud de presupuesto.`,
        tableTooLarge: (x) => `${b} reserva mesas en línea hasta ${x} personas: para más, contacta directamente.`,
      };
    case "fr":
      return {
        notForATime: `${b} ne prend pas de commandes pour une heure précise : commandez sans heure.`,
        chooseMethod: (x) =>
          x.length
            ? `${b} prend les commandes en : ${m(x)}. Choisissez dans fulfil.method.`
            : `${b} ne prend pas de commandes pour le moment.`,
        noTips: `${b} ne prend pas de pourboires en ligne.`,
        chooseSlot: "Choisissez un créneau de list_order_slots (fulfil.slot.start).",
        paused: (u, z) => `${b} ne prend plus de commandes jusqu'à ${clock(u, z, lang)}.`,
        notASlot: "Cette heure n'est pas un créneau de la cuisine : choisissez-en un de list_order_slots.",
        tooSoon: (e, z, n) =>
          `${n ? "Cette commande demande un délai" : "La cuisine a besoin de temps"} : le premier créneau possible est ${dayAndClock(e, z, lang)}.`,
        tooFar: (d) => `${b} prend les commandes jusqu'à ${d} jours à l'avance.`,
        slotFull: (n, z) =>
          n.length
            ? `Ce créneau est complet. Il reste : ${times(n, z)}.`
            : "Ce créneau est complet, et il n'en reste plus ce jour-là.",
        soldOut: (n) => `${n} est épuisé aujourd'hui.`,
        notAvailable: (n) => `${n} n'est pas en vente en ce moment.`,
        notThatDay: (n) => `${n} n'est pas préparé ce jour-là.`,
        notServedThen: (n) => `${n} n'est pas servi à cette heure.`,
        noDeliveryThere: `${b} ne livre pas à cette adresse : choisissez à emporter, ou une autre adresse.`,
        belowMinimum: (z, min) => `La commande minimum pour une livraison en ${z} est de ${money(min)}.`,
        fulfilLine: (x, at, z) => `${METHOD[lang][x]}${at !== null ? ` : ${dayAndClock(at, z, lang)}` : ""}`,
        feeLine: (z, f) => `Livraison${z ? ` (${z})` : ""} : ${f}`,
        tipLine: (t) => `Pourboire : ${t}`,
        slotsOpen: (n, f, z) => `${n} créneaux libres ; le premier, ${dayAndClock(f, z, lang)}.`,
        closedThatDay: `${b} ne prend pas de commandes ce jour-là.`,
        noDelivery: `${b} ne livre pas.`,
        addressUnknown: `${b} ne peut pas situer cette adresse : envoyez son code postal et son pays, ou son point ; sinon ${b} décide.`,
        takenElsewhere: (u) => `${b} prend les commandes sur ${u}, pas ici.`,
        tableQuote: (s) => `Pour ${s} personnes, ${b} prépare une proposition : c'est une demande de devis.`,
        tableTooLarge: (x) => `${b} réserve en ligne jusqu'à ${x} personnes : au-delà, contactez directement.`,
      };
    case "de":
      return {
        notForATime: `${b} nimmt keine Bestellungen für eine bestimmte Zeit an: bestell ohne Zeit.`,
        chooseMethod: (x) =>
          x.length
            ? `${b} nimmt Bestellungen an für: ${m(x)}. Wähle in fulfil.method.`
            : `${b} nimmt gerade keine Bestellungen an.`,
        noTips: `${b} nimmt online kein Trinkgeld an.`,
        chooseSlot: "Wähle ein Zeitfenster aus list_order_slots (fulfil.slot.start).",
        paused: (u, z) => `${b} nimmt bis ${clock(u, z, lang)} keine Bestellungen an.`,
        notASlot: "Diese Zeit ist kein Zeitfenster der Küche: wähle eines aus list_order_slots.",
        tooSoon: (e, z, n) =>
          `${n ? "Diese Bestellung braucht Vorlauf" : "Die Küche braucht Zeit"}: das erste mögliche Zeitfenster ist ${dayAndClock(e, z, lang)}.`,
        tooFar: (d) => `${b} nimmt Bestellungen bis zu ${d} Tage im Voraus an.`,
        slotFull: (n, z) =>
          n.length
            ? `Dieses Zeitfenster ist voll. Frei sind noch: ${times(n, z)}.`
            : "Dieses Zeitfenster ist voll, und an diesem Tag ist keines mehr frei.",
        soldOut: (n) => `${n} ist heute ausverkauft.`,
        notAvailable: (n) => `${n} gibt es gerade nicht.`,
        notThatDay: (n) => `${n} gibt es an diesem Tag nicht.`,
        notServedThen: (n) => `${n} gibt es zu dieser Zeit nicht.`,
        noDeliveryThere: `${b} liefert nicht an diese Adresse: wähle Abholung oder eine andere Adresse.`,
        belowMinimum: (z, min) => `Der Mindestbestellwert für eine Lieferung nach ${z} ist ${money(min)}.`,
        fulfilLine: (x, at, z) => `${METHOD[lang][x]}${at !== null ? `: ${dayAndClock(at, z, lang)}` : ""}`,
        feeLine: (z, f) => `Lieferung${z ? ` (${z})` : ""}: ${f}`,
        tipLine: (t) => `Trinkgeld: ${t}`,
        slotsOpen: (n, f, z) => `${n} freie Zeitfenster; das erste ${dayAndClock(f, z, lang)}.`,
        closedThatDay: `${b} nimmt an diesem Tag keine Bestellungen an.`,
        noDelivery: `${b} liefert nicht.`,
        addressUnknown: `${b} kann diese Adresse nicht zuordnen: schick ihre Postleitzahl und ihr Land oder ihren Punkt; sonst entscheidet ${b}.`,
        takenElsewhere: (u) => `${b} nimmt Bestellungen auf ${u} an, nicht hier.`,
        tableQuote: (s) => `Für ${s} Personen macht ${b} ein Angebot: es ist eine Anfrage.`,
        tableTooLarge: (x) => `${b} reserviert online bis ${x} Personen: für mehr bitte direkt melden.`,
      };
    case "it":
      return {
        notForATime: `${b} non prende ordini per un orario preciso: ordina senza orario.`,
        chooseMethod: (x) =>
          x.length ? `${b} prende ordini per: ${m(x)}. Scegli in fulfil.method.` : `${b} non prende ordini ora.`,
        noTips: `${b} non accetta mance online.`,
        chooseSlot: "Scegli una fascia da list_order_slots (fulfil.slot.start).",
        paused: (u, z) => `${b} non prende ordini fino alle ${clock(u, z, lang)}.`,
        notASlot: "Quell'orario non è una fascia della cucina: scegline una da list_order_slots.",
        tooSoon: (e, z, n) =>
          `${n ? "Questo ordine richiede preavviso" : "La cucina ha bisogno di tempo"}: la prima fascia possibile è ${dayAndClock(e, z, lang)}.`,
        tooFar: (d) => `${b} prende ordini fino a ${d} giorni prima.`,
        slotFull: (n, z) =>
          n.length
            ? `Quella fascia è piena. Restano: ${times(n, z)}.`
            : "Quella fascia è piena e non ne restano altre quel giorno.",
        soldOut: (n) => `${n} è esaurito oggi.`,
        notAvailable: (n) => `${n} non è in vendita ora.`,
        notThatDay: (n) => `${n} non si prepara quel giorno.`,
        notServedThen: (n) => `${n} non si serve a quell'ora.`,
        noDeliveryThere: `${b} non consegna a quell'indirizzo: scegli il ritiro, o un altro indirizzo.`,
        belowMinimum: (z, min) => `L'ordine minimo per la consegna in ${z} è ${money(min)}.`,
        fulfilLine: (x, at, z) => `${METHOD[lang][x]}${at !== null ? `: ${dayAndClock(at, z, lang)}` : ""}`,
        feeLine: (z, f) => `Consegna${z ? ` (${z})` : ""}: ${f}`,
        tipLine: (t) => `Mancia: ${t}`,
        slotsOpen: (n, f, z) => `${n} fasce libere; la prima, ${dayAndClock(f, z, lang)}.`,
        closedThatDay: `${b} non prende ordini quel giorno.`,
        noDelivery: `${b} non fa consegne.`,
        addressUnknown: `${b} non riesce a collocare quell'indirizzo: invia CAP e paese, o il punto; altrimenti decide ${b}.`,
        takenElsewhere: (u) => `${b} prende gli ordini su ${u}, non qui.`,
        tableQuote: (s) => `Per ${s} persone ${b} prepara una proposta: resta come richiesta di preventivo.`,
        tableTooLarge: (x) => `${b} prenota tavoli online fino a ${x} persone: per di più, contatta direttamente.`,
      };
    case "pt":
      return {
        notForATime: `${b} não aceita pedidos para uma hora certa: faz o pedido sem hora.`,
        chooseMethod: (x) =>
          x.length ? `${b} aceita pedidos para: ${m(x)}. Escolhe em fulfil.method.` : `${b} não aceita pedidos agora.`,
        noTips: `${b} não aceita gorjetas online.`,
        chooseSlot: "Escolhe um horário de list_order_slots (fulfil.slot.start).",
        paused: (u, z) => `${b} não aceita pedidos até às ${clock(u, z, lang)}.`,
        notASlot: "Essa hora não é um horário da cozinha: escolhe um de list_order_slots.",
        tooSoon: (e, z, n) =>
          `${n ? "Este pedido precisa de antecedência" : "A cozinha precisa de tempo"}: o primeiro horário possível é ${dayAndClock(e, z, lang)}.`,
        tooFar: (d) => `${b} aceita pedidos com até ${d} dias de antecedência.`,
        slotFull: (n, z) =>
          n.length
            ? `Esse horário está cheio. Restam: ${times(n, z)}.`
            : "Esse horário está cheio e não restam outros nesse dia.",
        soldOut: (n) => `${n} esgotou hoje.`,
        notAvailable: (n) => `${n} não está à venda agora.`,
        notThatDay: (n) => `${n} não se faz nesse dia.`,
        notServedThen: (n) => `${n} não se serve a essa hora.`,
        noDeliveryThere: `${b} não entrega nessa morada: escolhe levantamento, ou outra morada.`,
        belowMinimum: (z, min) => `O pedido mínimo para entrega em ${z} é ${money(min)}.`,
        fulfilLine: (x, at, z) => `${METHOD[lang][x]}${at !== null ? `: ${dayAndClock(at, z, lang)}` : ""}`,
        feeLine: (z, f) => `Entrega${z ? ` (${z})` : ""}: ${f}`,
        tipLine: (t) => `Gorjeta: ${t}`,
        slotsOpen: (n, f, z) => `${n} horários livres; o primeiro, ${dayAndClock(f, z, lang)}.`,
        closedThatDay: `${b} não aceita pedidos nesse dia.`,
        noDelivery: `${b} não faz entregas.`,
        addressUnknown: `${b} não consegue situar essa morada: envia o código postal e o país, ou o ponto; senão ${b} decide.`,
        takenElsewhere: (u) => `${b} recebe encomendas em ${u}, não aqui.`,
        tableQuote: (s) => `Para ${s} pessoas, ${b} prepara uma proposta: fica como pedido de orçamento.`,
        tableTooLarge: (x) => `${b} reserva mesas online até ${x} pessoas: para mais, contacta diretamente.`,
      };
    case "ja": {
      const j = business.trim() || "当店";
      return {
        notForATime: `${j}では時間指定のご注文を受け付けていません。時間を指定せずにご注文ください。`,
        chooseMethod: (x) =>
          x.length
            ? `${j}のご注文方法は${m(x)}です。fulfil.method で選んでください。`
            : `${j}は現在ご注文を受け付けていません。`,
        noTips: `${j}ではオンラインでのチップを受け付けていません。`,
        chooseSlot: "list_order_slots から時間枠を選んでください（fulfil.slot.start）。",
        paused: (u, z) => `${j}は${clock(u, z, lang)}までご注文を受け付けていません。`,
        notASlot: "その時間はキッチンの時間枠ではありません。list_order_slots から選んでください。",
        tooSoon: (e, z, n) =>
          `${n ? "このご注文は事前のご注文が必要です" : "準備に時間がかかります"}。最も早い時間枠は${dayAndClock(e, z, lang)}です。`,
        tooFar: (d) => `${j}では${d}日先までのご注文を受け付けています。`,
        slotFull: (n, z) =>
          n.length
            ? `その時間枠はいっぱいです。空いている時間：${times(n, z)}。`
            : "その時間枠はいっぱいで、その日はほかに空きがありません。",
        soldOut: (n) => `${n}は本日売り切れです。`,
        notAvailable: (n) => `${n}は現在お取り扱いしていません。`,
        notThatDay: (n) => `${n}はその日には作っていません。`,
        notServedThen: (n) => `${n}はその時間には提供していません。`,
        noDeliveryThere: `${j}はその住所には配達していません。お持ち帰りか、別の住所を選んでください。`,
        belowMinimum: (z, min) => `${z}への配達の最低注文金額は${money(min)}です。`,
        fulfilLine: (x, at, z) => `${METHOD[lang][x]}${at !== null ? `：${dayAndClock(at, z, lang)}` : ""}`,
        feeLine: (z, f) => `配達料${z ? `（${z}）` : ""}：${f}`,
        tipLine: (t) => `チップ：${t}`,
        slotsOpen: (n, f, z) => `空いている時間枠は${n}件、最初は${dayAndClock(f, z, lang)}です。`,
        closedThatDay: `${j}はその日はご注文を受け付けていません。`,
        noDelivery: `${j}は配達を行っていません。`,
        addressUnknown: `${j}ではその住所の場所がわかりません。郵便番号と国、または地点を送ってください。わからない場合は${j}が判断します。`,
        takenElsewhere: (u) => `${j}のご注文は${u}で承っています。こちらでは承っていません。`,
        tableQuote: (s) => `${s}名様のご予約は、${j}からご提案をお送りします。お見積りのご依頼として承ります。`,
        tableTooLarge: (x) =>
          `${j}のオンラインでの席のご予約は${x}名様までです。それ以上の場合は直接お問い合わせください。`,
      };
    }
    default:
      return {
        notForATime: `${b} does not take orders for a time: order without one.`,
        chooseMethod: (x) =>
          x.length ? `${b} takes orders for ${m(x)}. Choose one in fulfil.method.` : `${b} is not taking orders now.`,
        noTips: `${b} does not take tips online.`,
        chooseSlot: "Choose a slot from list_order_slots (fulfil.slot.start).",
        paused: (u, z) => `${b} is not taking orders until ${clock(u, z, lang)}.`,
        notASlot: "That time is not one of the kitchen's slots: choose one from list_order_slots.",
        tooSoon: (e, z, n) =>
          `${n ? "This order needs notice" : "The kitchen needs time"}: the first slot it can have is ${dayAndClock(e, z, lang)}.`,
        tooFar: (d) => `${b} takes orders up to ${d} days ahead.`,
        slotFull: (n, z) =>
          n.length ? `That slot is full. Still free: ${times(n, z)}.` : "That slot is full, and none is left that day.",
        soldOut: (n) => `${n} is sold out today.`,
        notAvailable: (n) => `${n} is not on sale now.`,
        notThatDay: (n) => `${n} is not made that day.`,
        notServedThen: (n) => `${n} is not served at that time.`,
        noDeliveryThere: `${b} does not deliver to that address: choose collection, or another address.`,
        belowMinimum: (z, min) => `The smallest order for delivery to ${z} is ${money(min)}.`,
        fulfilLine: (x, at, z) => `${cap(METHOD[lang][x])}${at !== null ? `: ${dayAndClock(at, z, lang)}` : ""}`,
        feeLine: (z, f) => `Delivery${z ? ` (${z})` : ""}: ${f}`,
        tipLine: (t) => `Tip: ${t}`,
        slotsOpen: (n, f, z) => `${n} free slot${n === 1 ? "" : "s"}; the first ${dayAndClock(f, z, lang)}.`,
        closedThatDay: `${b} does not take orders that day.`,
        noDelivery: `${b} does not deliver.`,
        addressUnknown: `${b} cannot place that address: send its postal code and country, or its point; otherwise ${b} decides.`,
        takenElsewhere: (u) => `${b} takes orders at ${u}, not here.`,
        tableQuote: (s) => `For ${s} people, ${b} puts together an offer: this is a request for a price.`,
        tableTooLarge: (x) => `${b} books tables online for up to ${x} people: for more, get in touch directly.`,
      };
  }
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
