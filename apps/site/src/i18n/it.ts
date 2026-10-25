import type { Dict } from "./types";

/**
 * Italiano, con il tu: scritto in italiano, non tradotto parola per parola. Le parole inglesi che
 * si cercano davvero (validator, generator) restano dove servono.
 */
export const it: Dict = {
  lang: "it",
  ui: {
    skip: "Vai al contenuto",
    langs: "Lingue",
    home: "Home",
    inShort: "In breve",
    questions: "Domande",
    related: "Vedi anche",
    updated: "Aggiornato il {date}",
    copy: "Copia",
    copied: "Copiato",
    copyFailed: "Seleziona il testo",
    wholeSite: "Controlla tutto il sito",
    wholeSiteLine: "cosa può fare un assistente con la tua attività, e cosa manca.",
    getInbox: "Ottieni la tua casella per agenti",
    nav: {
      "Check a business": "Verifica un'attività",
      Guides: "Guide",
      Directory: "Elenco",
      Leaderboards: "Classifiche",
      "For businesses": "Per le attività",
      "For agents": "Per gli agenti",
      Rules: "Regole",
      About: "Chi siamo",
      FAQ: "Domande frequenti",
      "How it works": "Come funziona",
      "Spam filter": "Filtro antispam",
      "Try it": "Provalo",
      Assistants: "Assistenti",
      Requests: "Richieste",
      Sponsors: "Sostenitori",
      Docs: "Documentazione",
      Technical: "Tecnica",
      Site: "Sito",
      "All pages": "Tutte le pagine",
      "Switch theme": "Cambia tema",
      Menu: "Menu",
      Theme: "Tema",
      Day: "Giorno",
      Night: "Notte",
      Install: "Installa",
      Specs: "Specifiche",
      Support: "Assistenza",
      Privacy: "Privacy",
      Terms: "Termini",
      Developers: "Sviluppatori",
      Legal: "Note legali",
      "How the network works": "Come funziona la rete",
      "Free tools": "Strumenti gratuiti",
      Search: "Cerca",
      Inbox: "Casella",
      "Trust network": "Rete di fiducia",
      Footer: "Piè di pagina",
      "Open doors to the agentic internet.": "Porte aperte sull'internet degli agenti.",
      "Open source under the MIT licence.": "Open source con licenza MIT.",
    },
  },

  hub: {
    title: "Strumenti gratuiti per preparare il tuo sito agli agenti IA",
    description:
      "Verifica gratis il tuo llms.txt, il robots.txt, il server MCP, i profili UCP e ACP e la casella per agenti, con guide chiare per piccole attività.",
    h1: "Strumenti gratuiti per preparare la tua attività agli agenti IA",
    intro:
      "Controlla una cosa, o tutto il sito. Ogni strumento ti dice cosa manca e come sistemarlo, in parole semplici. Senza registrazione.",
    short: "Strumenti e guide",
    idea: "Controlla una cosa,\no tutto il sito.",
    coverAlt:
      "Sette riquadri, uno per ogni strumento gratuito: tutto il sito, llms.txt, il generatore di llms.txt, robots.txt, MCP, UCP e ACP, e la casella per agenti. Una luce li visita uno alla volta.",
    toolsH: "Strumenti",
    tools: {
      check: {
        name: "La tua attività è pronta per gli agenti IA? Verifica completa",
        line: "Tutto il tuo sito, letto come lo leggerebbe l'assistente di un cliente: cosa può fare lì, e cosa manca.",
      },
      "llms-txt": {
        name: "Validatore llms.txt",
        line: "Ogni problema con il numero di riga e la correzione, poi gli accessi verso cui il tuo file porta gli agenti.",
      },
      "llms-txt-generator": {
        name: "Generatore di llms.txt",
        line: "Un llms.txt creato da quello che il tuo sito dice già, pronto da rivedere, verificare e pubblicare.",
      },
      "ai-crawlers": {
        name: "Controllo crawler IA",
        line: "Quali crawler di aziende di IA lascia entrare il tuo robots.txt, quali possono addestrarsi sulle tue pagine e quale riga lo decide.",
      },
      "mcp-server": {
        name: "Test del server MCP",
        line: "Cosa offre il tuo server MCP a un assistente, confrontato con la specifica attuale, senza mai chiamare uno strumento.",
      },
      ucp: {
        name: "Verifica UCP e ACP",
        line: "Se gli agenti IA trovano i profili di acquisto del tuo negozio, e cosa manca perché possano comprare.",
      },
      "agent-inbox": {
        name: "Verifica della casella per agenti",
        line: "Il manifesto della casella per agenti di un'attività, campo per campo secondo la specifica pubblicata, e se ogni accesso risponde.",
      },
    },
    spec: {
      name: "Verifica un manifesto o una ricevuta",
      line: "Incolla il manifesto di una casella per agenti o una ricevuta firmata e verificalo secondo la specifica, nel tuo browser.",
    },
    guidesH: "Guide",
    guides: {
      "validate-llms-txt": "Sette passi brevi, con gli errori più comuni e come correggere ognuno.",
      "llms-txt-examples":
        "File pronti da copiare: ristorante, parrucchiere, studio medico, negozio, artigiani e altro.",
      "ai-agent-assisted-payments":
        "Come un assistente paga per una persona, gli standard dietro e cosa fare già oggi.",
    },
    checklist: {
      name: "La checklist per gli agenti IA",
      line: "otto guide, una per ogni cosa che la verifica conta.",
      names: {
        "ai-assistant-bookings": "Prenotazioni",
        "sell-through-ai-assistants": "Vendite",
        "ai-assistant-messages-and-quotes": "Messaggi e preventivi",
        "ai-assistant-payments": "Pagamenti",
        "business-details-for-ai": "I tuoi dati leggibili",
        "findable-agent-doors": "Accessi facili da trovare",
        "llms-txt": "llms.txt",
        "robots-txt-ai-agents": "robots.txt",
      },
    },
    end: "Non sai da dove cominciare? [Controlla tutto il sito](@tool:check): vedi quali di questi contano per la tua attività.",
    cover: { site: "sito" },
  },

  validate: {
    title: "Come validare il tuo llms.txt, passo per passo · Surfing Dog",
    description:
      "Verifica il tuo llms.txt in cinque minuti: aprilo, guarda la prima riga, correggi i link e usa un validatore. Con gli errori più comuni e come risolverli.",
    h1: "Come validare il tuo llms.txt",
    intro: "Sette passi brevi, in ordine. Quasi tutti i problemi sono nella prima riga o nei link.",
    short: "Validare il tuo llms.txt",
    idea: "La riga 1 è il tuo nome.\nOgni link: [nome](https://…).",
    coverAlt:
      "Un llms.txt viene controllato riga per riga. Il nome alla riga 1 e il riassunto passano; un indirizzo nudo alla riga 5 diventa un link Markdown, e il file è valido.",
    form: {
      title: "Verifica ora il tuo llms.txt",
      label: "Il tuo sito",
      placeholder: "tuaattivita.com",
      button: "Verifica",
      note: "Gratis, senza registrazione. Leggiamo il tuo /llms.txt come farebbe un assistente e ti mostriamo ogni problema con la sua riga e la correzione.",
    },
    stepsH: "Sette passi",
    steps: [
      {
        name: "Aprilo",
        text: "Apri tuosito.com/llms.txt nel browser. Devi vedere del testo, non la tua home page né una pagina di errore.",
      },
      {
        name: "Guarda la riga 1",
        text: "La riga 1 è il tuo nome dopo un #: `# La tua attività`. È l'unico requisito del formato.",
      },
      {
        name: "Aggiungi un riassunto",
        text: "Subito sotto, una riga che inizia con >: cosa fai e dove. Facoltativa, ma aiuta.",
      },
      {
        name: "Fai di ogni link un link",
        text: "Sotto ogni titolo ##, un link per riga: `- [Nome](https://…): una breve nota`. Con indirizzi https completi.",
      },
      {
        name: "Usa un validatore",
        text: "Inserisci il tuo sito nel validatore in cima a questa pagina e correggi ogni riga indicata.",
      },
      {
        name: "Guarda cosa dice Lighthouse",
        text: "Facoltativo: in Chrome apri DevTools, poi Lighthouse, spunta la categoria Agentic Browsing ed eseguilo.",
      },
      {
        name: "Verifica di nuovo",
        text: "Carica il file corretto e verifica di nuovo. Una cache può mostrare il file vecchio per un po'.",
      },
    ],
    mail: {
      label: "Manda questi passi a chi cura il mio sito",
      subject: "Il nostro llms.txt: sette controlli",
      intro: "Ciao,\n\npuoi controllare il nostro llms.txt con questi sette passi?",
      validator: "Inserisci il sito su {url} e correggi ogni riga indicata.",
      outro: "La guida, con gli errori più comuni e come risolverli:",
    },
    errorsH: "Errori comuni e come risolverli",
    errorsCols: ["Cosa vedi", "La soluzione"],
    errors: [
      {
        problem: "La tua home page, o una pagina “non trovata”, su /llms.txt",
        fix: "Il file non c'è ancora. Carica un file chiamato llms.txt nella cartella principale del sito, o attivalo nella tua piattaforma.",
      },
      {
        problem: "La riga 1 non è `# Il tuo nome`",
        fix: "Metti alla riga 1 il nome della tua attività dopo un # e uno spazio. Prima, solo righe vuote.",
      },
      {
        problem: "`- Menu: https://…`",
        fix: "Scrivilo come link: `- [Menu](https://…): pranzo e cena`. Lighthouse di Chrome boccia un file senza alcun link Markdown.",
      },
      {
        problem: "Titoli `###`, o un titolo tra il tuo nome e le sezioni",
        fix: "Tieni un solo # per il tuo nome e usa ## per ogni sezione.",
      },
      {
        problem: "`http://` o `/menu`",
        fix: "Usa l'indirizzo completo con https: `https://tuaattivita.com/menu`.",
      },
      { problem: "Un link porta a una pagina che non esiste", fix: "Correggi l'indirizzo o togli la riga." },
      {
        problem: "Il tuo robots.txt blocca /llms.txt",
        fix: "Sbloccalo: i lettori che rispettano robots.txt non leggono un file bloccato. Il [controllo crawler IA](@tool:ai-crawlers) ti mostra la riga.",
      },
      {
        problem: "Errore 403 o 429, o una pagina “stiamo verificando il tuo browser”",
        fix: "Il tuo hosting o il tuo firewall ferma i lettori. Chiedi di lasciar passare /llms.txt.",
      },
      { problem: "Caratteri strani, come Ã© al posto di é", fix: "Salva il file come testo semplice UTF-8." },
    ],
    sampleH: "Com'è fatto un file valido",
    sampleIntro: "Breve, con il tuo nome per primo e un link per riga:",
    sample: `# Forno Spiga d'Oro

> Forno e caffetteria: pane a lievito madre, dolci e torte su ordinazione. Aperti tutti i giorni dalle 7.

## Vieni a trovarci e ordina

- [Prodotti e prezzi](https://spigadoro.example/prodotti): pane, dolci e caffè
- [Ordina una torta](https://spigadoro.example/torte): con tre giorni di anticipo
- [Orari e come arrivare](https://spigadoro.example/dove-siamo)

## Optional

- [La nostra storia](https://spigadoro.example/storia)`,
    sampleMore:
      "[Altri esempi](@llms-txt-examples): ristorante, parrucchiere, studio medico, negozio, artigiani e altro.",
    limitsH: "Cosa fa un file valido, e cosa no",
    limits: [
      "La Ricerca Google non usa llms.txt. Lighthouse di Chrome lo controlla, e alcuni strumenti di IA lo leggono.",
      "Un file valido aiuta un assistente a capire la tua attività. Perché possa chiedere, prenotare o ordinare ti serve un accesso: uno strumento, un'API o una [casella per agenti](@start) che riceve la richiesta. Per saperne di più (in inglese): [cosa fa llms.txt, e cosa no](@guide:llms-txt).",
    ],
    cover: { line: "Riga", name: "nome", summary: "riassunto", link: "link corretto", verdict: "llms.txt valido" },
    faqs: [
      {
        q: "Cosa rende valido un llms.txt?",
        a: "Secondo llmstxt.org è obbligatoria una sola cosa: un titolo # con il tuo nome. Un buon file aggiunge un riassunto con > e sezioni ## con link [nome](url).",
      },
      {
        q: "Google controlla il mio llms.txt?",
        a: "La Ricerca Google non lo usa. Lighthouse di Chrome (dalla 13.3) lo controlla in Agentic Browsing: un titolo #, almeno 50 caratteri e un link Markdown.",
      },
      {
        q: "Mi serve anche un llms-full.txt?",
        a: "No. llms-full.txt è un'abitudine della comunità, non fa parte della proposta llms.txt.",
      },
      {
        q: "Posso mettere llms.txt in una cartella?",
        a: "Sì. Dalla versione 2 della proposta (agosto 2026), un file in un percorso come /docs/llms.txt vale per le pagine sotto quel percorso.",
      },
    ],
  },

  examples: {
    title: "Esempi di llms.txt per piccole attività · Surfing Dog",
    description:
      "Esempi di llms.txt da copiare: ristorante, parrucchiere, studio medico, negozio, artigiani, hotel e altro, nel formato llmstxt.org. Copia e verifica.",
    h1: "Esempi di llms.txt per piccole attività",
    intro: "Scegli quello più simile alla tua attività, copialo, cambia testi e indirizzi e verificalo.",
    short: "Esempi di llms.txt",
    idea: "Un ristorante, un parrucchiere, un idraulico:\nun llms.txt per ciascuno, pronto da copiare.",
    coverAlt:
      "I riquadri di un ristorante, un parrucchiere, un artigiano e un negozio si accendono a turno, e accanto un llms.txt si riscrive per ognuno: il nome, la prima sezione e il primo link.",
    made: "Tutti i nomi e gli indirizzi sono inventati. Gli indirizzi che finiscono in .example non possono appartenere a nessuno.",
    jump: "Esempi",
    kinds: [
      {
        id: "restaurant",
        label: "Ristorante",
        name: "Ristorante, caffè o bar",
        note: "Menu, orari, prenotazioni e le condizioni su cui i clienti fanno domande.",
        file: `# Osteria del Melograno

> Osteria di quartiere con cucina di stagione da condividere e vini naturali. Aperti da martedì a domenica, a pranzo e a cena.

Per i piccoli gruppi non serve prenotare; da cinque persone in su, prenota. Piatti vegetariani e senza glutine ogni giorno; segnala le allergie quando prenoti.

## Vieni a trovarci e prenota

- [Menu e prezzi](https://melograno.example/menu): pranzo e cena, cambia ogni settimana
- [Orari e come arrivare](https://melograno.example/dove-siamo): indirizzo, mappa, mezzi pubblici
- [Prenota un tavolo](https://prenota.melograno.example/): online, fino a 8 persone
- [Eventi privati](https://melograno.example/eventi): gruppi da 10 a 40, preventivo su richiesta

## Condizioni

- [Disdette e caparre](https://melograno.example/condizioni): disdetta gratuita fino a 24 ore prima
- [Allergeni](https://melograno.example/allergeni): piatto per piatto

## Per gli agenti IA

- [Casella per agenti](https://casella.melograno.example/.well-known/agent-inbox.json): messaggi, preventivi e prenotazioni dei tavoli
- [Server MCP](https://casella.melograno.example/mcp): vedere la disponibilità, chiedere una prenotazione

## Optional

- [La nostra storia](https://melograno.example/storia)`,
      },
      {
        id: "salon",
        label: "Parrucchiere",
        name: "Parrucchiere, estetica o barbiere",
        note: "Servizi con i prezzi, la pagina di prenotazione che usi già e la regola sulle disdette.",
        file: `# Salone Ciliegio

> Parrucchiere ed estetica: taglio, colore, trecce, unghie e sopracciglia. Aperti da martedì a sabato, il giovedì fino a tardi.

Meglio su appuntamento; senza appuntamento se c'è una poltrona libera. Parliamo italiano, inglese e cinese.

## Servizi e appuntamenti

- [Servizi e prezzi](https://saloneciliegio.example/servizi): da una spuntatina al colore completo
- [Prenota un appuntamento](https://prenota.saloneciliegio.example/): scegli chi e quando
- [Il nostro staff](https://saloneciliegio.example/staff): chi fa cosa

## Condizioni

- [Disdette](https://saloneciliegio.example/disdette): gratuite fino a 24 ore prima; dopo si paga la metà
- [Buoni regalo](https://saloneciliegio.example/buoni): qualsiasi importo, validi 12 mesi

## Per gli agenti IA

- [Casella per agenti](https://casella.saloneciliegio.example/.well-known/agent-inbox.json): domande e richieste di appuntamento

## Optional

- [Consigli per i tuoi capelli](https://saloneciliegio.example/blog)`,
      },
      {
        id: "clinic",
        label: "Studio medico",
        name: "Studio: dentista, fisioterapista, veterinario o terapeuta",
        note: "Trattamenti, tariffe e come prenotare; mai nulla sui pazienti. Ancora senza accesso, quindi senza sezione per agenti.",
        file: `# Studio Dentistico Tiglio

> Studio dentistico per tutta la famiglia: controlli, igiene, otturazioni, sbiancamento e odontoiatria pediatrica. Aperti dal lunedì al sabato.

Nuovi pazienti benvenuti. Se hai un forte dolore o un gonfiore, chiamaci prima di venire.

## Trattamenti e prenotazioni

- [Trattamenti e tariffe](https://studiotiglio.example/trattamenti): fasce di prezzo per trattamento
- [Prenota una visita](https://studiotiglio.example/prenota): controlli e igiene online; il resto dopo un controllo
- [La tua prima visita](https://studiotiglio.example/prima-visita): cosa portare, quanto dura
- [Assicurazioni e pagamenti a rate](https://studiotiglio.example/assicurazioni)

## Condizioni

- [Disdette](https://studiotiglio.example/disdette): avvisaci con 24 ore di anticipo
- [Urgenze](https://studiotiglio.example/contatti): aiuto in giornata per dolore e incidenti

## Optional

- [I nostri dentisti](https://studiotiglio.example/staff)`,
      },
      {
        id: "shop",
        label: "Negozio",
        name: "Negozio online o di quartiere",
        note: "Collezioni, spedizioni e resi, e i profili di acquisto che molte piattaforme pubblicano per te.",
        file: `# Torrefazione Aurora

> Caffè di specialità tostato ogni settimana, in grani o macinato, e tutto per prepararlo. Spediamo in molti paesi.

Spedizione gratuita sopra un importo indicato al pagamento. Gli ordini entro le 14 partono lo stesso giorno lavorativo.

## Negozio

- [Caffè](https://torrefazioneaurora.example/caffe): origine, tostatura e note
- [Moke e macinini](https://torrefazioneaurora.example/attrezzi)
- [Abbonamento](https://torrefazioneaurora.example/abbonamento): ogni 2 o 4 settimane

## Ordini e condizioni

- [Spedizioni](https://torrefazioneaurora.example/spedizioni): tempi e costi per paese
- [Resi](https://torrefazioneaurora.example/resi): 30 giorni, confezione chiusa
- [Traccia un ordine](https://torrefazioneaurora.example/tracciamento)
- [Metodi di pagamento](https://torrefazioneaurora.example/pagamento): carta, wallet e bonifico

## Per gli agenti IA

- [Profilo del negozio (UCP)](https://torrefazioneaurora.example/.well-known/ucp): catalogo e acquisto
- [Server MCP](https://torrefazioneaurora.example/api/mcp): cercare prodotti, riempire il carrello

## Optional

- [Guide alla preparazione](https://torrefazioneaurora.example/blog)`,
      },
      {
        id: "trades",
        label: "Artigiani",
        name: "Artigiani: idraulico, elettricista, edilizia o pulizie",
        note: "Dove lavori, quanto costa un intervento e come chiedere un preventivo o un intervento urgente.",
        file: `# Idraulica Esposito

> Idraulica, riscaldamento e riparazione caldaie per case e piccole attività, in città e nei comuni vicini.

Diritto di chiamata fisso, poi un prezzo prima di iniziare. Pronto intervento tutti i giorni, dalle 7 alle 22.

## Servizi e preventivi

- [Servizi e zone servite](https://idraulicaesposito.example/servizi): riparazioni, installazioni, manutenzione
- [Prezzi e diritto di chiamata](https://idraulicaesposito.example/prezzi)
- [Chiedi un preventivo](https://idraulicaesposito.example/preventivo): le foto ci aiutano a darti un prezzo
- [Pronto intervento](https://idraulicaesposito.example/urgenze): orari e come contattarci

## Condizioni

- [Certificazioni e assicurazione](https://idraulicaesposito.example/certificazioni)
- [Garanzia](https://idraulicaesposito.example/garanzia): 12 mesi su ricambi e manodopera

## Per gli agenti IA

- [Casella per agenti](https://casella.idraulicaesposito.example/.well-known/agent-inbox.json): richieste di preventivo e messaggi

## Optional

- [Lavori recenti](https://idraulicaesposito.example/lavori)`,
      },
      {
        id: "stay",
        label: "Ospitalità",
        name: "Hotel, B&B o agriturismo",
        note: "Camere e tariffe, prenotazioni, orari di arrivo e le regole su cui gli ospiti fanno domande.",
        file: `# B&B Le Querce

> B&B con sei camere in collina, colazione inclusa e sentieri che partono dalla porta.

Check-in dalle 15, check-out entro le 11. Cani ammessi in due camere.

## Camere e prenotazioni

- [Camere e tariffe](https://lequerce.example/camere): foto e cosa è incluso
- [Prenota un soggiorno](https://lequerce.example/prenota): disponibilità in tempo reale
- [Come arrivare](https://lequerce.example/come-arrivare): in auto, in treno o con navetta

## Condizioni

- [Disdette](https://lequerce.example/disdette): gratuite fino a 7 giorni prima dell'arrivo
- [Animali](https://lequerce.example/animali)

## Per gli agenti IA

- [Casella per agenti](https://casella.lequerce.example/.well-known/agent-inbox.json): domande, gruppi e richieste di prenotazione

## Optional

- [Passeggiate nei dintorni](https://lequerce.example/passeggiate)`,
      },
      {
        id: "classes",
        label: "Corsi",
        name: "Corsi: palestra, yoga, danza o musica",
        note: "L'orario, gli abbonamenti e la prima lezione. Ancora senza accesso, quindi senza sezione per agenti.",
        file: `# Scuola di Danza Passo

> Scuola di danza con corsi per principianti ed esperti: classica, moderna, latino e hip hop, di pomeriggio e di sera.

La prima lezione è gratuita. Basta un abbigliamento comodo.

## Corsi e abbonamenti

- [Orario dei corsi](https://danzapasso.example/orario): tutti i corsi della settimana
- [Abbonamenti e carnet](https://danzapasso.example/prezzi)
- [Prenota una lezione](https://danzapasso.example/prenota)
- [La tua prima lezione](https://danzapasso.example/prima-lezione): cosa indossare, quando arrivare

## Condizioni

- [Disdette](https://danzapasso.example/disdette): fino a 4 ore prima della lezione

## Optional

- [Saggi e spettacoli](https://danzapasso.example/spettacoli)`,
      },
      {
        id: "professional",
        label: "Professionisti",
        name: "Professionisti: commercialista, avvocato, agenzia o consulenza",
        note: "Cosa fai, per chi, quanto costa e come iniziare.",
        file: `# Studio Conti & Adeyemi

> Contabilità, dichiarazioni dei redditi e buste paga per liberi professionisti e piccole imprese.

Lavoriamo in italiano, inglese e yoruba. Canoni mensili fissi; una prima telefonata di 20 minuti è gratuita.

## Servizi

- [Servizi e onorari](https://contiadeyemi.example/servizi): piani mensili e incarichi singoli
- [Prenota una prima telefonata](https://contiadeyemi.example/appuntamento)
- [Cosa preparare](https://contiadeyemi.example/documenti): i documenti per il primo incontro

## Condizioni

- [Condizioni dell'incarico](https://contiadeyemi.example/condizioni)
- [Privacy](https://contiadeyemi.example/privacy)

## Per gli agenti IA

- [Casella per agenti](https://casella.contiadeyemi.example/.well-known/agent-inbox.json): domande e richieste di preventivo

## Optional

- [Scadenze fiscali dell'anno](https://contiadeyemi.example/scadenze)`,
      },
      {
        id: "template",
        label: "Modello",
        name: "Un modello vuoto",
        note: "Sostituisci ogni {parte tra graffe} e cancella le righe che non ti servono.",
        file: `# {Nome della tua attività}

> {Cosa fai, e dove, in una riga.}

{Facoltativo: orari, zone servite, lingue parlate, metodi di pagamento.}

## {Servizi | Negozio | Vieni a trovarci e prenota}

- [{Servizi e prezzi}](https://{tuodominio}/{pagina}): {una breve nota}
- [{Orari e come arrivare}](https://{tuodominio}/{pagina})
- [{Prenota o ordina}](https://{il tuo indirizzo di prenotazione o negozio})

## Condizioni

- [{Disdette, spedizioni o resi}](https://{tuodominio}/{pagina})

## Per gli agenti IA

- [{Casella per agenti, server MCP o profilo del negozio}](https://{il suo indirizzo}): {cosa riceve}

## Optional

- [{Chi siamo}](https://{tuodominio}/{pagina})`,
      },
    ],
    howH: "Come usare un esempio",
    how: [
      "Copia l'esempio più vicino e cambia il nome, il riassunto e ogni indirizzo.",
      "Tieni solo ciò che è vero per te, e collega pagine che esistono già.",
      "Caricalo come llms.txt nella cartella principale del sito, così si apre su tuosito.com/llms.txt.",
      "Verificalo con il [validatore llms.txt](@tool:llms-txt) e correggi ogni riga indicata.",
    ],
    generator:
      "Oppure parti dal tuo sito: il [generatore di llms.txt](@tool:llms-txt-generator) scrive una prima versione da quello che il sito dice già.",
    doorsH: "La sezione “Per gli agenti IA”",
    doors: [
      "Elenca solo accessi che funzionano oggi: una casella per agenti, un server MCP, il profilo di acquisto di un negozio. Nessuno ancora? Togli la sezione. Una [casella per agenti](@start) te ne dà uno.",
      "## Optional è il nome che il formato dà, per convenzione, ai link che un lettore può saltare, per questo resta in inglese in ogni lingua.",
    ],
    faqs: [
      {
        q: "Cosa mette una piccola attività nel suo llms.txt?",
        a: "Il tuo nome come titolo #, una frase su cosa fai e dove, e i link alle pagine utili ai clienti: servizi e prezzi, orari e indirizzo, prenotazioni, condizioni. Aggiungi i tuoi accessi per agenti, se li hai.",
      },
      {
        q: "In che lingua lo scrivo?",
        a: "In quella dei tuoi clienti, la stessa del sito. Gli assistenti leggono molte lingue.",
      },
      {
        q: "Posso inserire la mia piattaforma di prenotazione o WhatsApp?",
        a: "Sì, come link con una nota: - [Prenota un tavolo](https://…): fino a 8 persone. Solo indirizzi pubblici, mai link privati o contatti del personale.",
      },
      {
        q: "Dove lo carico su Wix, Shopify o WordPress?",
        a: "Wix può crearlo per te; su WordPress, Yoast e AIOSEO; molti negozi Shopify ne pubblicano già uno. Altrove carica un file chiamato llms.txt nella cartella principale.",
      },
    ],
  },

  payments: {
    title: "Pagamenti agentici e assistiti da IA: cosa sono",
    description:
      "Un assistente IA riempie il carrello o prenota e la persona approva il pagamento. Come funziona e gli standard (carte, wallet, UCP, ACP, AP2, x402).",
    h1: "Pagamenti assistiti da agenti IA: cosa sono e come funzionano",
    intro:
      "Un pagamento che un assistente IA avvia o completa per una persona, che continua ad approvarlo. Ecco come funziona oggi e cosa può fare una piccola attività.",
    short: "Pagamenti assistiti da IA",
    idea: "L'assistente riempie il carrello.\nLa persona approva. Tu incassi.",
    coverAlt:
      "L'assistente di un cliente riempie un carrello e chiede alla persona di approvare. La persona approva sul telefono, un token limitato arriva all'attività, e l'attività incassa.",
    answer:
      "È un pagamento che un assistente IA prepara per una persona, che lo approva ancora con un tocco, una passkey o l'app della banca. L'attività incassa tramite il suo fornitore di sempre, e l'assistente non ha mai bisogno del numero della carta.",
    kindsH: "Assistito o agentico?",
    kinds: [
      {
        name: "Assistito da un agente",
        says: "L'assistente cerca, riempie il carrello o blocca l'appuntamento. La persona approva il pagamento, ogni volta.",
      },
      {
        name: "Agentico",
        says: "L'agente paga da solo, entro limiti che la persona ha fissato prima: un negozio, un importo, una data.",
      },
    ],
    kindsSource:
      "La società di ricerca Forrester ha tracciato questa distinzione a [novembre 2025](https://www.forrester.com/blogs/the-race-to-agentic-payments-in-us-b2c-e-commerce-where-we-are-now/), in inglese.",
    stepsH: "Come funziona",
    steps: [
      "L'assistente trova quello che vuole la persona, con il prezzo: un tavolo, un taglio, un prodotto.",
      "Riempie il carrello o blocca la prenotazione, e chiede alla persona di approvare.",
      "La persona approva con un tocco, una passkey o l'app della banca. L'approvazione diventa un token o un mandato, limitato a un'attività, un importo o un periodo.",
      "Il tuo checkout o il tuo fornitore di pagamenti verifica il token, e incassi come sempre. L'assistente non vede mai un numero di carta.",
    ],
    standardsH: "Gli standard di cui sentirai parlare",
    standardsCols: ["Nome", "Cos'è"],
    standards: [
      {
        name: "Token dei circuiti di carte",
        what: "Visa Intelligent Commerce e Mastercard Agent Pay: token che i circuiti emettono per gli agenti, tramite il tuo fornitore di pagamenti.",
      },
      {
        name: "Wallet e app bancarie",
        what: "Dove la persona approva, con una passkey o l'impronta, un pagamento preparato da un assistente.",
      },
      {
        name: "Mandati bancari",
        what: "Pagamenti da conto a conto con limiti fissati una volta, come Pix Automático, UPI AutoPay, PayTo o l'addebito diretto SEPA. Se un agente può usarne uno dipende dal sistema e dalla tua banca.",
      },
      {
        name: "UCP",
        what: "Universal Commerce Protocol: il profilo di acquisto di un negozio per gli agenti. I suoi metodi di pagamento dicono come può pagare un agente.",
        href: "https://ucp.dev",
      },
      {
        name: "ACP",
        what: "Agentic Commerce Protocol: un checkout per agenti, con pagamento delegato tramite il fornitore del negozio.",
        href: "https://www.agenticcommerce.dev",
      },
      {
        name: "AP2",
        what: "Agent Payments Protocol: mandati che una persona firma perché un agente paghi entro certi limiti.",
        href: "https://ap2-protocol.org",
      },
      {
        name: "x402",
        what: "Pagamenti via HTTP, soprattutto in stablecoin. Oggi si adatta più a software e API che a un parrucchiere o a un negozio.",
        href: "https://www.x402.org",
      },
    ],
    standardsNote:
      "Tutto questo cambia di mese in mese. Scritto a ottobre 2026; chiedi al tuo fornitore prima di scegliere.",
    doH: "Cosa può fare oggi una piccola attività",
    do: [
      "Scrivi sul tuo sito come incassi: subito, con caparra, all'arrivo o con fattura. Un assistente lo legge prima di impegnarsi per conto della persona.",
      "Manda un link di pagamento al tuo checkout. Funziona oggi con qualsiasi assistente: l'agente fa il resto, e paga una persona.",
      "Chiedi al tuo fornitore di pagamenti quali token per agenti e quali wallet accetta, e in quali paesi.",
      "Se vendi online, chiedi alla tua piattaforma se pubblica un profilo di acquisto (UCP o ACP) per il tuo negozio. La [verifica UCP e ACP](@tool:ucp) ti mostra cosa c'è.",
    ],
    counts: {
      h: "Nel nostro elenco",
      line: "Dei {checked} siti di attività che abbiamo controllato, {pay} incassano tramite un accesso che un agente può usare. Conteggio del {date}.",
      link: "Vedile nelle classifiche",
      wait: "Qui compaiono i conteggi in tempo reale del nostro elenco.",
      none: "I conteggi non sono disponibili in questo momento.",
    },
    next: "scopri se un assistente trova come pagarti.",
    cover: {
      assistant: "Il suo assistente",
      person: "La persona",
      business: "La tua attività",
      approve: "Approvi?",
      token: "Un negozio · un importo",
      paid: "Pagato",
    },
    faqs: [
      {
        q: "Che differenza c'è tra pagamento assistito e agentico?",
        a: "Nel pagamento assistito la persona lo approva, ad esempio con un tocco o una passkey. In quello agentico l'agente paga da solo entro limiti fissati prima. Forrester ha tracciato questa distinzione a novembre 2025.",
      },
      {
        q: "ChatGPT o un altro assistente può pagare?",
        a: "Alcuni assistenti riempiono un carrello o avviano un pagamento, e alcuni circuiti di pagamento permettono a un agente di pagare con un token approvato dalla persona. Ciò che è disponibile cambia per assistente, paese e fornitore.",
      },
      {
        q: "È sicuro che un agente paghi la mia attività?",
        a: "L'agente non ha bisogno del numero di carta: token, wallet e mandati valgono per un esercente, un importo o un periodo, e la persona li approva. Incassi tramite il tuo fornitore di sempre.",
      },
      {
        q: "Serve un nuovo software per accettarlo?",
        a: "Per iniziare di solito no: un link di pagamento sul tuo sito funziona con qualsiasi assistente. Token per agenti e wallet arrivano dal tuo fornitore di pagamenti; chiedigli quali supporta.",
      },
    ],
  },
};
