import type { Dict } from "./types";

/**
 * Deutsch, mit Sie, für Inhaberinnen, Inhaber und Handwerksbetriebe überall, wo Deutsch gesprochen
 * wird: auf Deutsch geschrieben, nicht Wort für Wort übersetzt. Die englischen Wörter, die
 * man hier tatsächlich sucht (Checker, Validator, Generator), bleiben.
 */
export const de: Dict = {
  lang: "de",
  ui: {
    skip: "Zum Inhalt springen",
    langs: "Sprachen",
    home: "Startseite",
    inShort: "Kurz gesagt",
    questions: "Fragen",
    related: "Passend dazu",
    updated: "Aktualisiert am {date}",
    copy: "Kopieren",
    copied: "Kopiert",
    copyFailed: "Bitte markieren",
    wholeSite: "Ganze Website prüfen",
    wholeSiteLine: "was ein Assistent bei Ihrem Unternehmen erledigen kann, und was fehlt.",
    getInbox: "Holen Sie sich Ihren Agenten-Posteingang",
    nav: {
      "Check a business": "Unternehmen prüfen",
      Guides: "Ratgeber",
      Directory: "Verzeichnis",
      Leaderboards: "Bestenlisten",
      "For businesses": "Für Unternehmen",
      "For agents": "Für Agenten",
      Rules: "Regeln",
      About: "Über uns",
      FAQ: "FAQ",
      "How it works": "So funktioniert es",
      "Spam filter": "Spamfilter",
      "Try it": "Ausprobieren",
      Assistants: "Assistenten",
      Requests: "Anfragen",
      Sponsors: "Sponsoren",
      Docs: "Dokumentation",
      Technical: "Technik",
      Site: "Website",
      "All pages": "Alle Seiten",
      "Switch theme": "Darstellung wechseln",
      Menu: "Menü",
      Theme: "Darstellung",
      Day: "Tag",
      Night: "Nacht",
      Install: "Installieren",
      Specs: "Spezifikationen",
      Support: "Hilfe",
      Privacy: "Datenschutz",
      Terms: "Bedingungen",
      Developers: "Entwickler",
      Legal: "Rechtliches",
      "How the network works": "So funktioniert das Netzwerk",
      "Free tools": "Kostenlose Tools",
      Search: "Suche",
      Inbox: "Posteingang",
      "Trust network": "Vertrauensnetz",
      Footer: "Fußzeile",
      "Open doors to the agentic internet.": "Offene Türen ins Internet der Agenten.",
      "Open source under the MIT licence.": "Open Source unter der MIT-Lizenz.",
    },
  },

  hub: {
    title: "Kostenlose Tools: Website für KI-Agenten vorbereiten",
    description:
      "Prüfen Sie kostenlos llms.txt, robots.txt, Ihren MCP-Server, UCP- und ACP-Profile und Ihren Agenten-Posteingang. Mit klaren Ratgebern, ohne Anmeldung.",
    h1: "Kostenlose Tools: Ist Ihr Unternehmen bereit für KI-Agenten?",
    intro:
      "Prüfen Sie einen Punkt oder Ihre ganze Website. Jedes Tool zeigt, was fehlt und wie Sie es beheben, in klaren Worten. Ohne Anmeldung.",
    short: "Tools und Ratgeber",
    idea: "Einen Punkt prüfen,\noder die ganze Website.",
    coverAlt:
      "Sieben Kacheln, eine für jedes kostenlose Tool: die ganze Website, llms.txt, der llms.txt-Generator, robots.txt, MCP, UCP und ACP und der Agenten-Posteingang. Ein Licht besucht jede der Reihe nach.",
    toolsH: "Tools",
    tools: {
      check: {
        name: "KI-Agenten-Check für Ihre Website",
        line: "Ihre ganze Website, gelesen wie vom Assistenten eines Kunden: was er dort erledigen kann, und was fehlt.",
      },
      "llms-txt": {
        name: "llms.txt-Checker und -Validator",
        line: "Jeder Fehler mit Zeilennummer und Korrektur, dazu die Zugänge, zu denen Ihre Datei Agenten führt.",
      },
      "llms-txt-generator": {
        name: "llms.txt-Generator",
        line: "Eine llms.txt aus dem, was Ihre Website schon sagt, bereit zum Prüfen, Anpassen und Hochladen.",
      },
      "ai-crawlers": {
        name: "KI-Crawler-Check",
        line: "Welche Crawler von KI-Anbietern Ihre robots.txt hereinlässt, welche mit Ihren Seiten trainieren dürfen, und welche Zeile das entscheidet.",
      },
      "mcp-server": {
        name: "MCP-Server testen",
        line: "Was Ihr MCP-Server einem Assistenten anbietet, geprüft nach der aktuellen Spezifikation, ohne je ein Tool aufzurufen.",
      },
      ucp: {
        name: "UCP- und ACP-Check",
        line: "Ob KI-Agenten die Kaufprofile Ihres Shops finden, und was ihnen zum Einkaufen fehlt.",
      },
      "agent-inbox": {
        name: "Agenten-Posteingang prüfen",
        line: "Das Manifest des Agenten-Posteingangs eines Unternehmens, Feld für Feld nach der veröffentlichten Spezifikation, und ob jeder Zugang antwortet.",
      },
    },
    spec: {
      name: "Manifest oder Beleg prüfen",
      line: "Fügen Sie das Manifest eines Agenten-Posteingangs oder einen signierten Beleg ein und prüfen Sie ihn nach der Spezifikation, im Browser.",
    },
    guidesH: "Ratgeber",
    guides: {
      "validate-llms-txt": "Sieben kurze Schritte, mit den häufigsten Fehlern und ihrer Lösung.",
      "llms-txt-examples": "Dateien zum Kopieren: Restaurant, Friseur, Praxis, Onlineshop, Handwerk und mehr.",
      "ai-agent-assisted-payments":
        "Wie ein Assistent für eine Person bezahlt, welche Standards dahinterstehen und was Sie jetzt tun können.",
    },
    checklist: {
      name: "Die Checkliste für KI-Agenten",
      line: "acht Ratgeber, einer für jeden Punkt, den der Check zählt.",
      names: {
        "ai-assistant-bookings": "Buchungen",
        "sell-through-ai-assistants": "Verkaufen",
        "ai-assistant-messages-and-quotes": "Nachrichten und Angebote",
        "ai-assistant-payments": "Bezahlen",
        "business-details-for-ai": "Ihre Angaben als Daten",
        "findable-agent-doors": "Auffindbare Zugänge",
        "llms-txt": "llms.txt",
        "robots-txt-ai-agents": "robots.txt",
      },
    },
    end: "Nicht sicher, wo Sie anfangen sollen? [Prüfen Sie Ihre ganze Website](@tool:check): Sie sehen, welche davon für Ihr Unternehmen zählen.",
    cover: { site: "Website" },
  },

  validate: {
    title: "llms.txt validieren: so prüfen Sie Ihre Datei · Surfing Dog",
    description:
      "Prüfen Sie Ihre llms.txt in fünf Minuten: öffnen, erste Zeile ansehen, Links korrigieren, Validator laufen lassen. Mit den häufigsten Fehlern und Lösungen.",
    h1: "So validieren Sie Ihre llms.txt",
    intro: "Sieben kurze Schritte, der Reihe nach. Die meisten Fehler stecken in der ersten Zeile oder in den Links.",
    short: "llms.txt validieren",
    idea: "Zeile 1 ist Ihr Name.\nJeder Link: [Name](https://…).",
    coverAlt:
      "Eine llms.txt wird Zeile für Zeile geprüft. Der Name in Zeile 1 und die Zusammenfassung passen; eine nackte Adresse in Zeile 5 wird zum Markdown-Link, und die Datei ist gültig.",
    form: {
      title: "Jetzt Ihre llms.txt prüfen",
      label: "Ihre Website",
      placeholder: "ihrunternehmen.com",
      button: "Prüfen",
      note: "Kostenlos, ohne Anmeldung. Wir lesen Ihre /llms.txt so, wie ein Assistent es täte, und zeigen jedes Problem mit Zeile und Lösung.",
    },
    stepsH: "Sieben Schritte",
    steps: [
      {
        name: "Öffnen",
        text: "Öffnen Sie ihrewebsite.com/llms.txt im Browser. Sie sollten Text sehen, nicht Ihre Startseite oder eine Fehlerseite.",
      },
      {
        name: "Zeile 1 ansehen",
        text: "Zeile 1 ist Ihr Name nach einem #: `# Ihr Unternehmen`. Mehr verlangt das Format nicht.",
      },
      {
        name: "Zusammenfassung ergänzen",
        text: "Darunter eine Zeile, die mit > beginnt: was Sie wo anbieten. Optional, aber hilfreich.",
      },
      {
        name: "Jeden Link als Link schreiben",
        text: "Unter jeder ##-Überschrift ein Link pro Zeile: `- [Name](https://…): kurze Notiz`. Mit vollständigen https-Adressen.",
      },
      {
        name: "Validator laufen lassen",
        text: "Geben Sie Ihre Website oben in den llms.txt-Checker ein und korrigieren Sie jede genannte Zeile.",
      },
      {
        name: "Lighthouse ansehen",
        text: "Optional: In Chrome die DevTools öffnen, dann Lighthouse, die Kategorie Agentic Browsing anhaken und ausführen.",
      },
      {
        name: "Erneut prüfen",
        text: "Laden Sie die korrigierte Datei hoch und prüfen Sie erneut. Ein Cache kann kurz noch die alte Datei zeigen.",
      },
    ],
    mail: {
      label: "Diese Schritte an die Person schicken, die meine Website betreut",
      subject: "Unsere llms.txt: sieben Prüfungen",
      intro: "Hallo,\n\nkönnten Sie unsere llms.txt mit diesen sieben Schritten prüfen?",
      validator: "Geben Sie die Website unter {url} ein und korrigieren Sie jede genannte Zeile.",
      outro: "Der Ratgeber, mit den häufigsten Fehlern und Lösungen:",
    },
    errorsH: "Häufige Fehler und wie Sie sie beheben",
    errorsCols: ["Was Sie sehen", "Die Lösung"],
    errors: [
      {
        problem: "Ihre Startseite oder eine „Nicht gefunden“-Seite unter /llms.txt",
        fix: "Es gibt noch keine Datei. Laden Sie eine Datei namens llms.txt ins Hauptverzeichnis, oder schalten Sie sie in Ihrer Plattform ein.",
      },
      {
        problem: "Zeile 1 ist nicht `# Ihr Name`",
        fix: "Schreiben Sie in Zeile 1 den Namen Ihres Unternehmens nach einem # und einem Leerzeichen. Davor höchstens Leerzeilen.",
      },
      {
        problem: "`- Speisekarte: https://…`",
        fix: "Schreiben Sie es als Link: `- [Speisekarte](https://…): Mittag und Abend`. Chromes Lighthouse lässt eine Datei ohne Markdown-Link durchfallen.",
      },
      {
        problem: "`###`-Überschriften oder eine Überschrift zwischen Name und Abschnitten",
        fix: "Ein einziges # für Ihren Namen, ## für jeden Abschnitt.",
      },
      {
        problem: "`http://` oder `/speisekarte`",
        fix: "Verwenden Sie die vollständige Adresse mit https: `https://ihrunternehmen.com/speisekarte`.",
      },
      { problem: "Ein Link führt zu einer Seite, die es nicht gibt", fix: "Adresse korrigieren oder Zeile entfernen." },
      {
        problem: "Ihre robots.txt sperrt /llms.txt",
        fix: "Geben Sie sie frei: Leser, die robots.txt beachten, holen eine gesperrte Datei nicht. Der [KI-Crawler-Check](@tool:ai-crawlers) zeigt die Zeile.",
      },
      {
        problem: "Fehler 403 oder 429, oder eine Seite „Ihr Browser wird überprüft“",
        fix: "Ihr Hoster oder Ihre Firewall blockiert Leser. Bitten Sie darum, /llms.txt freizugeben.",
      },
      { problem: "Seltsame Zeichen wie Ã¼ statt ü", fix: "Speichern Sie die Datei als reinen Text in UTF-8." },
    ],
    sampleH: "So sieht eine gültige Datei aus",
    sampleIntro: "Kurz, mit Ihrem Namen zuerst und einem Link pro Zeile:",
    sample: `# Bäckerei Kornfeld

> Bäckerei und Café für Sauerteigbrot, Gebäck und Torten auf Bestellung. Täglich ab 7 Uhr geöffnet.

## Besuchen und bestellen

- [Sortiment und Preise](https://baeckerei-kornfeld.example/sortiment): Brot, Gebäck und Kaffee
- [Torte bestellen](https://baeckerei-kornfeld.example/torten): drei Tage im Voraus
- [Öffnungszeiten und Anfahrt](https://baeckerei-kornfeld.example/anfahrt)

## Optional

- [Über uns](https://baeckerei-kornfeld.example/ueber-uns)`,
    sampleMore: "[Weitere Beispiele](@llms-txt-examples): Restaurant, Friseur, Praxis, Onlineshop, Handwerk und mehr.",
    limitsH: "Was eine gültige Datei leistet, und was nicht",
    limits: [
      "Die Google-Suche nutzt llms.txt nicht. Chromes Lighthouse prüft sie, und manche KI-Tools lesen sie.",
      "Eine gültige Datei hilft einem Assistenten, Ihr Unternehmen zu verstehen. Damit er anfragen, buchen oder bestellen kann, brauchen Sie einen Zugang: ein Tool, eine API oder einen [Agenten-Posteingang](@start), der die Anfrage annimmt. Mehr dazu (auf Englisch): [was llms.txt kann, und was nicht](@guide:llms-txt).",
    ],
    cover: {
      line: "Zeile",
      name: "Name",
      summary: "Zusammenfassung",
      link: "Link korrigiert",
      verdict: "Gültige llms.txt",
    },
    faqs: [
      {
        q: "Wann ist eine llms.txt gültig?",
        a: "Laut llmstxt.org ist nur eines Pflicht: eine #-Überschrift mit Ihrem Namen. Eine gute Datei ergänzt eine Zusammenfassung mit > und ##-Abschnitte mit Links im Format [Name](URL).",
      },
      {
        q: "Prüft Google meine llms.txt?",
        a: "Die Google-Suche nutzt sie nicht. Chromes Lighthouse (ab 13.3) prüft sie unter Agentic Browsing: eine #-Überschrift, mindestens 50 Zeichen und ein Markdown-Link.",
      },
      {
        q: "Brauche ich auch eine llms-full.txt?",
        a: "Nein. llms-full.txt ist eine Gepflogenheit der Community, kein Teil des llms.txt-Vorschlags.",
      },
      {
        q: "Darf die llms.txt in einem Unterordner liegen?",
        a: "Ja. Seit Version 2 des Vorschlags (August 2026) gilt eine Datei unter einem Pfad wie /docs/llms.txt für die Seiten darunter.",
      },
    ],
  },

  examples: {
    title: "llms.txt-Beispiele für kleine Unternehmen · Surfing Dog",
    description:
      "llms.txt-Beispiele zum Kopieren: Restaurant, Friseur, Praxis, Onlineshop, Handwerk, Hotel und mehr, im Format von llmstxt.org. Kopieren, anpassen, prüfen.",
    h1: "llms.txt-Beispiele für kleine Unternehmen",
    intro: "Nehmen Sie das passendste Beispiel, kopieren Sie es, ändern Sie Texte und Adressen und prüfen Sie es.",
    short: "llms.txt-Beispiele",
    idea: "Restaurant, Friseur, Handwerk:\neine llms.txt für jeden, zum Kopieren.",
    coverAlt:
      "Kacheln für ein Restaurant, einen Friseur, einen Handwerksbetrieb und einen Shop leuchten nacheinander auf, und daneben schreibt sich eine llms.txt für jeden neu: Name, erster Abschnitt, erster Link.",
    made: "Alle Namen und Adressen sind erfunden. Adressen mit der Endung .example können niemandem gehören.",
    jump: "Beispiele",
    kinds: [
      {
        id: "restaurant",
        label: "Restaurant",
        name: "Restaurant, Café oder Bar",
        note: "Speisekarte, Öffnungszeiten, Reservierung und die Bedingungen, nach denen Gäste fragen.",
        file: `# Restaurant Feldkümmel

> Restaurant im Viertel mit saisonaler Küche zum Teilen und Naturweinen. Dienstag bis Sonntag, mittags und abends.

Kleine Gruppen ohne Reservierung; ab fünf Personen bitte reservieren. Täglich vegetarische und glutenfreie Gerichte; Allergien bitte bei der Reservierung nennen.

## Besuchen und reservieren

- [Speisekarte und Preise](https://feldkuemmel.example/speisekarte): mittags und abends, wechselt wöchentlich
- [Öffnungszeiten und Anfahrt](https://feldkuemmel.example/anfahrt): Adresse, Karte, öffentliche Verkehrsmittel
- [Tisch reservieren](https://reservierung.feldkuemmel.example/): online, bis 8 Personen
- [Geschlossene Gesellschaften](https://feldkuemmel.example/feiern): 10 bis 40 Personen, Angebot auf Anfrage

## Bedingungen

- [Stornierung und Anzahlung](https://feldkuemmel.example/bedingungen): kostenlos bis 24 Stunden vorher
- [Allergene](https://feldkuemmel.example/allergene): Gericht für Gericht

## Für KI-Agenten

- [Agenten-Posteingang](https://posteingang.feldkuemmel.example/.well-known/agent-inbox.json): Nachrichten, Angebotsanfragen und Tischreservierungen
- [MCP-Server](https://posteingang.feldkuemmel.example/mcp): freie Tische prüfen, Reservierung anfragen

## Optional

- [Über uns](https://feldkuemmel.example/ueber-uns)`,
      },
      {
        id: "salon",
        label: "Friseur",
        name: "Friseur, Kosmetik oder Barbier",
        note: "Leistungen mit Preisen, Ihre bestehende Buchungsseite und die Stornoregel.",
        file: `# Haarwerk Mira

> Friseursalon und Kosmetik: Schnitt, Farbe, Flechtfrisuren, Nägel und Augenbrauen. Dienstag bis Samstag, donnerstags länger.

Am besten mit Termin; ohne Termin, wenn ein Stuhl frei ist. Wir sprechen Deutsch, Englisch und Türkisch.

## Leistungen und Termine

- [Leistungen und Preise](https://haarwerk-mira.example/leistungen): vom Ponyschnitt bis zur Komplettfarbe
- [Termin buchen](https://termine.haarwerk-mira.example/): Stylistin und Uhrzeit wählen
- [Unser Team](https://haarwerk-mira.example/team): wer was macht

## Bedingungen

- [Stornierung](https://haarwerk-mira.example/stornierung): kostenlos bis 24 Stunden vorher; danach die Hälfte
- [Gutscheine](https://haarwerk-mira.example/gutscheine): jeder Betrag, 12 Monate gültig

## Für KI-Agenten

- [Agenten-Posteingang](https://posteingang.haarwerk-mira.example/.well-known/agent-inbox.json): Fragen und Terminanfragen

## Optional

- [Haarpflege-Tipps](https://haarwerk-mira.example/blog)`,
      },
      {
        id: "clinic",
        label: "Praxis",
        name: "Praxis: Zahnarzt, Physiotherapie, Tierarzt oder Therapie",
        note: "Behandlungen, Preise und Terminvergabe; niemals etwas über Patientinnen und Patienten. Noch kein Zugang, also kein Abschnitt für Agenten.",
        file: `# Zahnarztpraxis am Stadtpark

> Zahnarztpraxis für die ganze Familie: Kontrolle, Prophylaxe, Füllungen, Bleaching und Kinderzahnheilkunde. Montag bis Samstag.

Neue Patientinnen und Patienten willkommen. Bei starken Schmerzen oder Schwellung rufen Sie bitte vorher an.

## Behandlungen und Termine

- [Behandlungen und Preise](https://praxis-stadtpark.example/behandlungen): Preisspannen je Behandlung
- [Termin vereinbaren](https://praxis-stadtpark.example/termin): Kontrolle und Prophylaxe online; alles andere nach einer Kontrolle
- [Ihr erster Besuch](https://praxis-stadtpark.example/erster-besuch): was Sie mitbringen, wie lange es dauert
- [Versicherungen und Ratenzahlung](https://praxis-stadtpark.example/versicherungen)

## Bedingungen

- [Terminabsagen](https://praxis-stadtpark.example/absagen): bitte 24 Stunden vorher
- [Notfälle](https://praxis-stadtpark.example/kontakt): Hilfe am selben Tag bei Schmerzen und Unfällen

## Optional

- [Unsere Zahnärztinnen und Zahnärzte](https://praxis-stadtpark.example/team)`,
      },
      {
        id: "shop",
        label: "Onlineshop",
        name: "Onlineshop oder Laden",
        note: "Sortiment, Versand und Rückgabe, dazu die Kaufprofile, die viele Shop-Plattformen für Sie veröffentlichen.",
        file: `# Teekontor Nordlicht

> Lose Tees und Teezubehör, frisch verpackt. Wir versenden in viele Länder aus unserem eigenen Lager.

Versandkostenfrei ab einem Betrag, der an der Kasse angezeigt wird. Bestellungen bis 14 Uhr gehen am selben Werktag raus.

## Shop

- [Schwarzer und grüner Tee](https://teekontor-nordlicht.example/kollektionen/tee)
- [Kannen und Tassen](https://teekontor-nordlicht.example/kollektionen/zubehoer)
- [Geschenksets](https://teekontor-nordlicht.example/kollektionen/geschenke)

## Bestellung und Bedingungen

- [Versand](https://teekontor-nordlicht.example/versand): Lieferzeiten und Kosten je Land
- [Rückgabe](https://teekontor-nordlicht.example/rueckgabe): 30 Tage, ungeöffnet
- [Sendung verfolgen](https://teekontor-nordlicht.example/sendung)
- [Zahlungsarten](https://teekontor-nordlicht.example/zahlung): Karte, Wallets und Überweisung

## Für KI-Agenten

- [Shop-Profil (UCP)](https://teekontor-nordlicht.example/.well-known/ucp): Katalog und Kauf
- [MCP-Server](https://teekontor-nordlicht.example/api/mcp): Produkte suchen, Warenkorb füllen

## Optional

- [Zubereitungstipps](https://teekontor-nordlicht.example/blog)`,
      },
      {
        id: "trades",
        label: "Handwerk",
        name: "Handwerk: Sanitär, Elektro, Bau oder Reinigung",
        note: "Wo Sie arbeiten, was eine Anfahrt kostet und wie man ein Angebot oder einen Notdienst anfragt.",
        file: `# Haustechnik Yılmaz

> Sanitär, Heizung und Thermenreparatur für Haushalte und kleine Betriebe, in der Stadt und im Umland.

Feste Anfahrtspauschale, dann ein Preis, bevor wir anfangen. Notdienst täglich von 7 bis 22 Uhr.

## Leistungen und Angebote

- [Leistungen und Einsatzgebiet](https://haustechnik-yilmaz.example/leistungen): Reparatur, Einbau, Wartung
- [Preise und Anfahrt](https://haustechnik-yilmaz.example/preise)
- [Angebot anfragen](https://haustechnik-yilmaz.example/angebot): Fotos helfen beim Kalkulieren
- [Notdienst](https://haustechnik-yilmaz.example/notdienst): Zeiten und Erreichbarkeit

## Bedingungen

- [Zertifikate und Versicherung](https://haustechnik-yilmaz.example/zertifikate)
- [Gewährleistung](https://haustechnik-yilmaz.example/gewaehrleistung): 12 Monate auf Material und Arbeit

## Für KI-Agenten

- [Agenten-Posteingang](https://posteingang.haustechnik-yilmaz.example/.well-known/agent-inbox.json): Angebotsanfragen und Nachrichten

## Optional

- [Aktuelle Projekte](https://haustechnik-yilmaz.example/projekte)`,
      },
      {
        id: "stay",
        label: "Unterkunft",
        name: "Hotel, Pension oder Ferienwohnung",
        note: "Zimmer und Preise, Buchung, Anreisezeiten und die Regeln, nach denen Gäste fragen.",
        file: `# Pension Alpenblick

> Pension mit acht Zimmern in den Bergen, Frühstück inklusive, Wanderwege direkt vor der Tür.

Anreise ab 15 Uhr, Abreise bis 11 Uhr. Hunde in zwei Zimmern willkommen.

## Zimmer und Buchung

- [Zimmer und Preise](https://pension-alpenblick.example/zimmer): mit Fotos und Leistungen
- [Aufenthalt buchen](https://pension-alpenblick.example/buchen): freie Zimmer in Echtzeit
- [Anreise](https://pension-alpenblick.example/anreise): mit Auto, Bahn oder Shuttle

## Bedingungen

- [Stornierung](https://pension-alpenblick.example/stornierung): kostenlos bis 7 Tage vor Anreise
- [Haustiere](https://pension-alpenblick.example/haustiere)

## Für KI-Agenten

- [Agenten-Posteingang](https://posteingang.pension-alpenblick.example/.well-known/agent-inbox.json): Fragen, Gruppen und Buchungsanfragen

## Optional

- [Wanderungen in der Nähe](https://pension-alpenblick.example/wandern)`,
      },
      {
        id: "classes",
        label: "Kurse",
        name: "Kurse: Fitness, Yoga, Tanz oder Musik",
        note: "Stundenplan, Mitgliedschaften und die erste Stunde. Noch kein Zugang, also kein Abschnitt für Agenten.",
        file: `# Tanzschule Takt

> Tanzschule mit Kursen für Anfänger und Fortgeschrittene: Standard, Latein, Salsa und Hip-Hop, nachmittags und abends.

Die erste Stunde ist kostenlos. Bequeme Kleidung genügt.

## Kurse und Mitgliedschaften

- [Stundenplan](https://tanzschule-takt.example/stundenplan): alle Kurse dieser Woche
- [Mitgliedschaften und Zehnerkarten](https://tanzschule-takt.example/preise)
- [Kurs buchen](https://tanzschule-takt.example/buchen)
- [Ihre erste Stunde](https://tanzschule-takt.example/erste-stunde): was Sie anziehen, wann Sie kommen

## Bedingungen

- [Absagen](https://tanzschule-takt.example/absagen): bis 4 Stunden vor Kursbeginn

## Optional

- [Bälle und Feste](https://tanzschule-takt.example/baelle)`,
      },
      {
        id: "professional",
        label: "Beratung",
        name: "Freie Berufe: Steuerberatung, Kanzlei, Agentur oder Beratung",
        note: "Was Sie tun, für wen, was es kostet und wie man anfängt.",
        file: `# Steuerberatung Keller & Nowak

> Buchhaltung, Steuererklärungen und Lohnabrechnung für Selbstständige und kleine Unternehmen.

Wir beraten auf Deutsch, Englisch und Polnisch. Feste Monatspauschalen; ein erstes Gespräch von 20 Minuten ist kostenlos.

## Leistungen

- [Leistungen und Honorare](https://keller-nowak.example/leistungen): Monatspauschalen und Einzelaufträge
- [Erstgespräch buchen](https://keller-nowak.example/termin)
- [Was Sie vorbereiten](https://keller-nowak.example/unterlagen): Unterlagen für den ersten Termin

## Bedingungen

- [Auftragsbedingungen](https://keller-nowak.example/bedingungen)
- [Datenschutz](https://keller-nowak.example/datenschutz)

## Für KI-Agenten

- [Agenten-Posteingang](https://posteingang.keller-nowak.example/.well-known/agent-inbox.json): Fragen und Angebotsanfragen

## Optional

- [Steuertermine des Jahres](https://keller-nowak.example/steuertermine)`,
      },
      {
        id: "template",
        label: "Vorlage",
        name: "Eine leere Vorlage",
        note: "Ersetzen Sie jeden {Teil in geschweiften Klammern} und löschen Sie, was Sie nicht brauchen.",
        file: `# {Name Ihres Unternehmens}

> {Was Sie tun, und wo, in einer Zeile.}

{Optional: Öffnungszeiten, Einsatzgebiet, Sprachen, Zahlungsarten.}

## {Leistungen | Shop | Besuchen und buchen}

- [{Leistungen und Preise}](https://{ihredomain}/{seite}): {kurze Notiz}
- [{Öffnungszeiten und Anfahrt}](https://{ihredomain}/{seite})
- [{Buchen oder bestellen}](https://{Ihre Buchungs- oder Shop-Adresse})

## Bedingungen

- [{Stornierung, Versand oder Rückgabe}](https://{ihredomain}/{seite})

## Für KI-Agenten

- [{Agenten-Posteingang, MCP-Server oder Shop-Profil}](https://{seine Adresse}): {was er annimmt}

## Optional

- [{Über uns}](https://{ihredomain}/{seite})`,
      },
    ],
    howH: "So verwenden Sie ein Beispiel",
    how: [
      "Kopieren Sie das passendste Beispiel und ändern Sie Namen, Zusammenfassung und jede Adresse.",
      "Behalten Sie nur, was für Sie stimmt, und verlinken Sie Seiten, die es schon gibt.",
      "Laden Sie die Datei als llms.txt ins Hauptverzeichnis, damit sie unter ihrewebsite.com/llms.txt erscheint.",
      "Prüfen Sie sie mit dem [llms.txt-Checker](@tool:llms-txt) und korrigieren Sie jede genannte Zeile.",
    ],
    generator:
      "Oder starten Sie mit Ihrer eigenen Website: Der [llms.txt-Generator](@tool:llms-txt-generator) schreibt eine erste Fassung aus dem, was Ihre Website schon sagt.",
    doorsH: "Der Abschnitt „Für KI-Agenten“",
    doors: [
      "Nennen Sie nur Zugänge, die heute funktionieren: einen Agenten-Posteingang, einen MCP-Server, das Kaufprofil eines Shops. Noch keiner? Lassen Sie den Abschnitt weg. Ein [Agenten-Posteingang](@start) gibt Ihnen einen.",
      "## Optional ist der Name, den das Format per Konvention Links gibt, die ein Leser überspringen darf. Er bleibt deshalb in jeder Sprache englisch.",
    ],
    faqs: [
      {
        q: "Was gehört in die llms.txt eines kleinen Unternehmens?",
        a: "Ihr Name als #-Überschrift, ein Satz dazu, was Sie wo anbieten, und Links zu den Seiten, die Kunden helfen: Leistungen und Preise, Öffnungszeiten und Anfahrt, Buchung, Bedingungen. Dazu Ihre Zugänge für Agenten, falls vorhanden.",
      },
      {
        q: "In welcher Sprache schreibe ich sie?",
        a: "In der Sprache Ihrer Kunden, wie Ihre Website. Assistenten lesen viele Sprachen.",
      },
      {
        q: "Darf ich meine Buchungsplattform oder WhatsApp verlinken?",
        a: "Ja, als Link mit Notiz: - [Termin buchen](https://…): Schnitt und Farbe. Nur öffentliche Adressen, nie private Links oder Kontakte von Mitarbeitenden.",
      },
      {
        q: "Wo lade ich sie bei Wix, Shopify oder WordPress hoch?",
        a: "Wix kann sie für Sie erstellen; bei WordPress Yoast und AIOSEO; viele Shopify-Shops liefern schon eine aus. Sonst laden Sie eine Datei namens llms.txt ins Hauptverzeichnis.",
      },
    ],
  },

  payments: {
    title: "Agentic Payments und KI-assistiertes Bezahlen: was ist das?",
    description:
      "Ein KI-Assistent füllt den Warenkorb oder bucht, die Person gibt die Zahlung frei. So funktioniert es, mit Standards (Karten, Wallets, UCP, ACP, AP2).",
    h1: "KI-assistiertes Bezahlen: was es ist und wie es funktioniert",
    intro:
      "Eine Zahlung, die ein KI-Assistent für eine Person startet oder abschließt, während die Person sie weiterhin freigibt. So funktioniert es heute, und das kann ein kleines Unternehmen tun.",
    short: "KI-assistiertes Bezahlen",
    idea: "Der Assistent füllt den Warenkorb.\nDie Person gibt frei. Sie werden bezahlt.",
    coverAlt:
      "Der Assistent eines Kunden füllt einen Warenkorb und bittet die Person um Freigabe. Sie gibt am Handy frei, ein begrenzter Token geht an das Unternehmen, und das Unternehmen wird bezahlt.",
    answer:
      "Eine Zahlung, die ein KI-Assistent für eine Person vorbereitet; die Person gibt sie weiterhin frei, per Fingertipp, Passkey oder Banking-App. Das Unternehmen wird über seinen gewohnten Anbieter bezahlt, und der Assistent braucht nie eine Kartennummer.",
    kindsH: "Assistiert oder agentisch?",
    kinds: [
      {
        name: "Assistiert",
        says: "Der Assistent sucht, füllt den Warenkorb oder hält den Termin. Die Person gibt die Zahlung frei, jedes Mal.",
      },
      {
        name: "Agentisch",
        says: "Der Agent zahlt selbst, innerhalb von Grenzen, die die Person vorher gesetzt hat: ein Shop, ein Betrag, ein Datum.",
      },
    ],
    kindsSource:
      "Das Analysehaus Forrester hat diese Trennung im [November 2025](https://www.forrester.com/blogs/the-race-to-agentic-payments-in-us-b2c-e-commerce-where-we-are-now/) gezogen, auf Englisch.",
    stepsH: "So funktioniert es",
    steps: [
      "Der Assistent findet, was die Person möchte, mit Preis: einen Tisch, einen Haarschnitt, ein Produkt.",
      "Er füllt den Warenkorb oder hält den Termin und bittet die Person um Freigabe.",
      "Die Person gibt frei, per Fingertipp, Passkey oder Banking-App. Die Freigabe wird zu einem Token oder Mandat, begrenzt auf ein Unternehmen, einen Betrag oder einen Zeitraum.",
      "Ihre Kasse oder Ihr Zahlungsanbieter prüft den Token, und Sie werden wie gewohnt bezahlt. Der Assistent sieht nie eine Kartennummer.",
    ],
    standardsH: "Die Standards, von denen Sie hören werden",
    standardsCols: ["Name", "Was es ist"],
    standards: [
      {
        name: "Token der Kartennetze",
        what: "Visa Intelligent Commerce und Mastercard Agent Pay: Token, die die Kartennetze für Agenten ausgeben, erreichbar über Ihren Zahlungsanbieter.",
      },
      {
        name: "Wallets und Banking-Apps",
        what: "Wo die Person eine Zahlung, die ein Assistent vorbereitet hat, per Passkey oder Fingerabdruck freigibt.",
      },
      {
        name: "Bankmandate",
        what: "Zahlungen von Konto zu Konto mit einmal gesetzten Grenzen, etwa Pix Automático, UPI AutoPay, PayTo oder die SEPA-Lastschrift. Ob ein Agent sie nutzen darf, hängt vom Verfahren und Ihrer Bank ab.",
      },
      {
        name: "UCP",
        what: "Universal Commerce Protocol: das Kaufprofil eines Shops für Agenten. Seine Zahlungsarten sagen, wie ein Agent bezahlen kann.",
        href: "https://ucp.dev",
      },
      {
        name: "ACP",
        what: "Agentic Commerce Protocol: ein Checkout für Agenten, mit delegierter Zahlung über den Anbieter des Shops.",
        href: "https://www.agenticcommerce.dev",
      },
      {
        name: "AP2",
        what: "Agent Payments Protocol: Mandate, die eine Person unterschreibt, damit ein Agent innerhalb von Grenzen zahlt.",
        href: "https://ap2-protocol.org",
      },
      {
        name: "x402",
        what: "Bezahlen über HTTP, meist in Stablecoins. Passt heute eher zu Software und APIs als zu einem Friseur oder einem Laden.",
        href: "https://www.x402.org",
      },
    ],
    standardsNote:
      "Das ändert sich von Monat zu Monat. Geschrieben im Oktober 2026; fragen Sie Ihren Anbieter, bevor Sie wählen.",
    doH: "Was ein kleines Unternehmen jetzt tun kann",
    do: [
      "Schreiben Sie auf Ihre Website, wie Sie bezahlt werden: sofort, mit Anzahlung, vor Ort oder auf Rechnung. Ein Assistent liest das, bevor er im Namen der Person zusagt.",
      "Schicken Sie einen Zahlungslink zu Ihrer eigenen Kasse. Das funktioniert heute mit jedem Assistenten: Der Agent erledigt den Rest, und ein Mensch zahlt.",
      "Fragen Sie Ihren Zahlungsanbieter, welche Agenten-Token und Wallets er annimmt, und in welchen Ländern.",
      "Wenn Sie online verkaufen, fragen Sie Ihre Shop-Plattform, ob sie ein Kaufprofil (UCP oder ACP) für Ihren Shop veröffentlicht. Der [UCP- und ACP-Check](@tool:ucp) zeigt, was da ist.",
    ],
    counts: {
      h: "In unserem Verzeichnis",
      line: "Von den {checked} Unternehmenswebsites, die wir geprüft haben, nehmen {pay} Zahlungen über einen Zugang an, den ein Agent nutzen kann. Stand: {date}.",
      link: "In den Bestenlisten ansehen",
      wait: "Hier erscheinen die aktuellen Zahlen aus unserem Verzeichnis.",
      none: "Die Zahlen sind gerade nicht abrufbar.",
    },
    next: "sehen Sie, ob ein Assistent herausfindet, wie man Sie bezahlt.",
    cover: {
      assistant: "Sein Assistent",
      person: "Die Person",
      business: "Ihr Unternehmen",
      approve: "Freigeben?",
      token: "Ein Shop · ein Betrag",
      paid: "Bezahlt",
    },
    faqs: [
      {
        q: "Was unterscheidet assistierte von agentischen Zahlungen?",
        a: "Bei der assistierten Zahlung gibt die Person sie frei, etwa per Fingertipp oder Passkey. Bei der agentischen zahlt der Agent selbst innerhalb vorher festgelegter Grenzen. Forrester hat diese Trennung im November 2025 gezogen.",
      },
      {
        q: "Kann ChatGPT oder ein anderer Assistent bezahlen?",
        a: "Manche Assistenten füllen einen Warenkorb oder starten eine Zahlung, und manche Zahlungsnetze lassen einen Agenten mit einem freigegebenen Token zahlen. Was verfügbar ist, hängt von Assistent, Land und Anbieter ab.",
      },
      {
        q: "Ist es sicher, wenn ein Agent mein Unternehmen bezahlt?",
        a: "Der Agent braucht keine Kartennummer: Token, Wallets und Mandate gelten nur für einen Händler, Betrag oder Zeitraum, und die Person gibt sie frei. Sie werden über Ihren gewohnten Anbieter bezahlt.",
      },
      {
        q: "Brauche ich neue Software dafür?",
        a: "Zum Start meist nicht: Ein Zahlungslink auf Ihrer eigenen Website funktioniert mit jedem Assistenten. Agenten-Token und Wallets kommen über Ihren Zahlungsanbieter; fragen Sie, welche er unterstützt.",
      },
    ],
  },
};
