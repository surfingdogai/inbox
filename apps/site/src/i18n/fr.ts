import type { Dict } from "./types";

/**
 * Français, au vouvoiement, pour la France, la Belgique, la Suisse, le Québec et l'Afrique
 * francophone : écrit en français, pas traduit mot à mot.
 */
export const fr: Dict = {
  lang: "fr",
  ui: {
    skip: "Aller au contenu",
    langs: "Langues",
    home: "Accueil",
    inShort: "En bref",
    questions: "Questions",
    related: "À voir aussi",
    updated: "Mis à jour le {date}",
    copy: "Copier",
    copied: "Copié",
    copyFailed: "Sélectionnez le texte",
    wholeSite: "Vérifier tout votre site",
    wholeSiteLine: "ce qu'un assistant peut faire avec votre entreprise, et ce qui manque.",
    getInbox: "Obtenez votre boîte de réception pour agents",
    nav: {
      "Check a business": "Vérifier une entreprise",
      Guides: "Guides",
      Directory: "Annuaire",
      Leaderboards: "Classements",
      "For businesses": "Pour les entreprises",
      "For agents": "Pour les agents",
      Rules: "Règles",
      About: "À propos",
      FAQ: "FAQ",
      "How it works": "Comment ça marche",
      "Spam filter": "Filtre anti-spam",
      "Try it": "Essayer",
      Assistants: "Assistants",
      Integrations: "Intégrations",
      Requests: "Demandes",
      Sponsors: "Soutiens",
      Docs: "Documentation",
      Technical: "Technique",
      Site: "Site",
      "All pages": "Toutes les pages",
      "Switch theme": "Changer de thème",
      Menu: "Menu",
      Theme: "Thème",
      Day: "Jour",
      Night: "Nuit",
      Install: "Installer",
      Specs: "Spécifications",
      Support: "Aide",
      Privacy: "Confidentialité",
      Terms: "Conditions",
      Developers: "Développeurs",
      Legal: "Juridique",
      "How the network works": "Fonctionnement du réseau",
      "Free tools": "Outils gratuits",
      Search: "Recherche",
      Inbox: "Boîte de réception",
      "Trust network": "Réseau de confiance",
      Footer: "Pied de page",
      "Open doors to the agentic internet.": "Des portes ouvertes sur l'internet des agents.",
      "Open source under the MIT licence.": "Open source, sous licence MIT.",
    },
  },

  hub: {
    title: "Outils gratuits pour préparer votre site aux agents IA",
    description:
      "Vérifiez gratuitement votre llms.txt, robots.txt, serveur MCP, profils UCP et ACP et boîte de réception pour agents. Guides clairs, sans inscription.",
    h1: "Outils gratuits pour préparer votre entreprise aux agents IA",
    intro:
      "Vérifiez un point, ou tout votre site. Chaque outil vous dit ce qui manque et comment le corriger, simplement. Sans inscription.",
    short: "Outils et guides",
    idea: "Vérifiez un point,\nou tout votre site.",
    coverAlt:
      "Sept tuiles, une par outil gratuit : tout le site, llms.txt, le générateur de llms.txt, robots.txt, MCP, UCP et ACP, et la boîte de réception pour agents. Une lumière passe sur chacune.",
    toolsH: "Outils",
    tools: {
      check: {
        name: "Votre entreprise est-elle prête pour les agents IA ? Test complet",
        line: "Tout votre site, lu comme le lirait l'assistant d'un client : ce qu'il peut y faire, et ce qui manque.",
      },
      "llms-txt": {
        name: "Validateur llms.txt",
        line: "Chaque problème avec son numéro de ligne et la correction, puis les accès vers lesquels votre fichier mène les agents.",
      },
      "llms-txt-generator": {
        name: "Générateur de llms.txt",
        line: "Un llms.txt créé à partir de ce que dit déjà votre site, prêt à relire, vérifier et mettre en ligne.",
      },
      "ai-crawlers": {
        name: "Vérificateur de robots IA",
        line: "Quels robots d'entreprises d'IA votre robots.txt laisse entrer, lesquels peuvent s'entraîner sur vos pages, et la ligne qui en décide.",
      },
      "mcp-server": {
        name: "Test de serveur MCP",
        line: "Ce que votre serveur MCP propose à un assistant, comparé à la spécification actuelle, sans jamais appeler un outil.",
      },
      ucp: {
        name: "Vérificateur UCP et ACP",
        line: "Si les agents IA trouvent les profils d'achat de votre boutique, et ce qui leur manque pour acheter.",
      },
      "agent-inbox": {
        name: "Vérificateur de boîte de réception pour agents",
        line: "Le manifeste de la boîte de réception pour agents d'une entreprise, champ par champ selon la spécification publiée, et si chaque accès répond.",
      },
    },
    spec: {
      name: "Vérifier un manifeste ou un reçu",
      line: "Collez le manifeste d'une boîte de réception pour agents ou un reçu signé et vérifiez-le selon la spécification, dans votre navigateur.",
    },
    guidesH: "Guides",
    guides: {
      "validate-llms-txt": "Sept étapes courtes, avec les erreurs les plus courantes et la façon de corriger chacune.",
      "llms-txt-examples": "Des fichiers prêts à copier : restaurant, salon, cabinet, boutique, artisan et plus.",
      "ai-agent-assisted-payments":
        "Comment un assistant paie pour une personne, les normes derrière, et que faire dès maintenant.",
    },
    checklist: {
      name: "La liste de préparation aux agents IA",
      line: "huit guides, un pour chaque point que compte le test.",
      names: {
        "ai-assistant-bookings": "Réservations",
        "sell-through-ai-assistants": "Vente",
        "ai-assistant-messages-and-quotes": "Messages et devis",
        "ai-assistant-payments": "Paiements",
        "business-details-for-ai": "Vos informations lisibles",
        "findable-agent-doors": "Des accès faciles à trouver",
        "llms-txt": "llms.txt",
        "robots-txt-ai-agents": "robots.txt",
      },
    },
    end: "Vous ne savez pas par où commencer ? [Vérifiez tout votre site](@tool:check) : vous verrez lesquels comptent pour votre entreprise.",
    cover: { site: "site" },
  },

  validate: {
    title: "Comment valider votre fichier llms.txt · Surfing Dog",
    description:
      "Vérifiez votre llms.txt en cinq minutes : ouvrez-le, regardez la première ligne, corrigez les liens, lancez un validateur. Avec les erreurs courantes.",
    h1: "Comment valider votre fichier llms.txt",
    intro: "Sept étapes courtes, dans l'ordre. La plupart des problèmes sont sur la première ligne ou dans les liens.",
    short: "Valider votre llms.txt",
    idea: "La ligne 1, c'est votre nom.\nChaque lien : [nom](https://…).",
    coverAlt:
      "Un llms.txt est vérifié ligne par ligne. Le nom en ligne 1 et le résumé passent ; une adresse brute en ligne 5 devient un lien Markdown, et le fichier est valide.",
    form: {
      title: "Vérifiez votre llms.txt maintenant",
      label: "Votre site",
      placeholder: "votreentreprise.com",
      button: "Vérifier",
      note: "Gratuit, sans inscription. Nous lisons votre /llms.txt comme le ferait un assistant, et vous montrons chaque problème avec sa ligne et sa correction.",
    },
    stepsH: "Sept étapes",
    steps: [
      {
        name: "Ouvrez-le",
        text: "Ouvrez votresite.com/llms.txt dans le navigateur. Vous devez voir du texte, pas votre page d'accueil ni une page d'erreur.",
      },
      {
        name: "Regardez la ligne 1",
        text: "La ligne 1 est votre nom après un # : `# Votre entreprise`. C'est la seule exigence du format.",
      },
      {
        name: "Ajoutez un résumé",
        text: "Juste en dessous, une ligne qui commence par > : ce que vous faites et où. Facultatif, mais utile.",
      },
      {
        name: "Faites de chaque lien un lien",
        text: "Sous chaque titre ##, un lien par ligne : `- [Nom](https://…): une courte note`. Avec des adresses https complètes.",
      },
      {
        name: "Lancez un validateur",
        text: "Indiquez votre site dans le validateur en haut de cette page et corrigez chaque ligne signalée.",
      },
      {
        name: "Voyez ce que dit Lighthouse",
        text: "Facultatif : dans Chrome, ouvrez DevTools, puis Lighthouse, cochez la catégorie Agentic Browsing et lancez-le.",
      },
      {
        name: "Vérifiez à nouveau",
        text: "Mettez en ligne le fichier corrigé, puis revérifiez. Un cache peut montrer l'ancien fichier un petit moment.",
      },
    ],
    mail: {
      label: "Envoyer ces étapes à la personne qui gère mon site",
      subject: "Notre llms.txt : sept vérifications",
      intro: "Bonjour,\n\nPourriez-vous vérifier notre llms.txt avec ces sept étapes ?",
      validator: "Indiquez le site sur {url} et corrigez chaque ligne signalée.",
      outro: "Le guide, avec les erreurs courantes et leurs corrections :",
    },
    errorsH: "Erreurs courantes et corrections",
    errorsCols: ["Ce que vous voyez", "La correction"],
    errors: [
      {
        problem: "Votre page d'accueil, ou une page « introuvable », à /llms.txt",
        fix: "Il n'y a pas encore de fichier. Déposez un fichier nommé llms.txt à la racine de votre site, ou activez-le dans votre plateforme.",
      },
      {
        problem: "La ligne 1 n'est pas `# Votre nom`",
        fix: "À la ligne 1, écrivez le nom de votre entreprise après un # et une espace. Seules des lignes vides peuvent la précéder.",
      },
      {
        problem: "`- Carte : https://…`",
        fix: "Écrivez-le comme un lien : `- [Carte](https://…): midi et soir`. Lighthouse de Chrome refuse un fichier sans aucun lien Markdown.",
      },
      {
        problem: "Des titres `###`, ou un titre entre votre nom et vos sections",
        fix: "Gardez un seul # pour votre nom et utilisez ## pour chaque section.",
      },
      {
        problem: "`http://` ou `/carte`",
        fix: "Utilisez l'adresse complète en https : `https://votreentreprise.com/carte`.",
      },
      { problem: "Un lien mène à une page qui n'existe pas", fix: "Corrigez l'adresse ou retirez la ligne." },
      {
        problem: "Votre robots.txt bloque /llms.txt",
        fix: "Autorisez-le : les lecteurs qui respectent robots.txt ne lisent pas un fichier bloqué. Le [vérificateur de robots IA](@tool:ai-crawlers) montre la ligne.",
      },
      {
        problem: "Erreur 403 ou 429, ou une page « vérification de votre navigateur »",
        fix: "Votre hébergeur ou votre pare-feu bloque les lecteurs. Demandez-lui de laisser passer /llms.txt.",
      },
      { problem: "Des caractères bizarres, comme Ã© au lieu de é", fix: "Enregistrez le fichier en texte brut UTF-8." },
    ],
    sampleH: "À quoi ressemble un fichier valide",
    sampleIntro: "Court, avec votre nom d'abord et un lien par ligne :",
    sample: `# Boulangerie Le Fournil d'Aïcha

> Boulangerie et salon de thé : pain au levain, viennoiseries et gâteaux sur commande. Ouvert tous les jours dès 7 h.

## Venir et commander

- [Produits et prix](https://fournil-aicha.example/produits): pains, viennoiseries et cafés
- [Commander un gâteau](https://fournil-aicha.example/gateaux): trois jours à l'avance
- [Horaires et accès](https://fournil-aicha.example/venir)

## Optional

- [Notre histoire](https://fournil-aicha.example/histoire)`,
    sampleMore: "[D'autres exemples](@llms-txt-examples) : restaurant, salon, cabinet, boutique, artisan et plus.",
    limitsH: "Ce que fait un fichier valide, et ce qu'il ne fait pas",
    limits: [
      "La recherche Google n'utilise pas llms.txt. Lighthouse de Chrome l'audite, et certains outils d'IA le lisent.",
      "Un fichier valide aide un assistant à comprendre votre activité. Pour qu'il puisse demander, réserver ou commander, il vous faut un accès : un outil, une API ou une [boîte de réception pour agents](@start) qui prend la demande. Plus de détails (en anglais) dans [ce que fait llms.txt, et ce qu'il ne fait pas](@guide:llms-txt).",
    ],
    cover: { line: "Ligne", name: "nom", summary: "résumé", link: "lien corrigé", verdict: "llms.txt valide" },
    faqs: [
      {
        q: "Qu'est-ce qui rend un llms.txt valide ?",
        a: "Selon llmstxt.org, une seule chose est obligatoire : un titre # avec votre nom. Un bon fichier ajoute un résumé avec > et des sections ## de liens [nom](url).",
      },
      {
        q: "Google vérifie-t-il mon llms.txt ?",
        a: "La recherche Google ne l'utilise pas. Lighthouse de Chrome (13.3 et suivantes) le contrôle dans Agentic Browsing : un titre #, au moins 50 caractères et un lien Markdown.",
      },
      {
        q: "Me faut-il aussi un llms-full.txt ?",
        a: "Non. llms-full.txt est un usage de la communauté, pas une partie de la proposition llms.txt.",
      },
      {
        q: "Puis-je placer le llms.txt dans un dossier ?",
        a: "Oui. Depuis la version 2 de la proposition (août 2026), un fichier à un chemin comme /docs/llms.txt couvre les pages sous ce chemin.",
      },
    ],
  },

  examples: {
    title: "Exemples de llms.txt pour petites entreprises",
    description:
      "Exemples de llms.txt à copier : restaurant, salon de coiffure, cabinet, boutique, artisan, hôtel et plus, au format llmstxt.org. Copiez, vérifiez.",
    h1: "Exemples de llms.txt pour petites entreprises",
    intro:
      "Choisissez celui qui ressemble le plus à votre activité, copiez-le, adaptez textes et adresses, puis vérifiez-le.",
    short: "Exemples de llms.txt",
    idea: "Un restaurant, un salon, un plombier :\nun llms.txt pour chacun, prêt à copier.",
    coverAlt:
      "Les tuiles d'un restaurant, d'un salon, d'un artisan et d'une boutique s'allument tour à tour, et à côté un llms.txt se réécrit pour chacun : son nom, sa première section et son premier lien.",
    made: "Tous les noms et adresses sont inventés. Les adresses en .example ne peuvent appartenir à personne.",
    jump: "Exemples",
    kinds: [
      {
        id: "restaurant",
        label: "Restaurant",
        name: "Restaurant, café ou bar",
        note: "La carte, les horaires, la réservation et les conditions que les clients demandent.",
        file: `# Le Comptoir d'Awa

> Restaurant de quartier, cuisine de saison à partager et vins nature. Ouvert du mardi au dimanche, midi et soir.

Pas besoin de réserver pour les petits groupes ; à partir de cinq personnes, réservez. Plats végétariens et sans gluten tous les jours ; signalez vos allergies en réservant.

## Venir et réserver

- [Carte et prix](https://comptoir-awa.example/carte): midi et soir, change chaque semaine
- [Horaires et accès](https://comptoir-awa.example/venir): adresse, plan, transports en commun
- [Réserver une table](https://reservation.comptoir-awa.example/): en ligne, jusqu'à 8 personnes
- [Événements privés](https://comptoir-awa.example/evenements): groupes de 10 à 40, devis sur demande

## Conditions

- [Annulations et acomptes](https://comptoir-awa.example/conditions): annulation gratuite jusqu'à 24 heures avant
- [Allergènes](https://comptoir-awa.example/allergenes): plat par plat

## Pour les agents IA

- [Boîte de réception pour agents](https://boite.comptoir-awa.example/.well-known/agent-inbox.json): messages, devis et réservations de table
- [Serveur MCP](https://boite.comptoir-awa.example/mcp): voir les disponibilités, demander une réservation

## Optional

- [Notre histoire](https://comptoir-awa.example/histoire)`,
      },
      {
        id: "salon",
        label: "Salon",
        name: "Coiffure, beauté ou barbier",
        note: "Les prestations avec leurs tarifs, la page de réservation que vous utilisez déjà et la règle d'annulation.",
        file: `# Atelier Coiffure Rivage

> Salon de coiffure et de beauté : coupes, couleur, tresses, ongles et sourcils. Ouvert du mardi au samedi, tard le jeudi.

De préférence sur rendez-vous ; sans rendez-vous quand un fauteuil est libre. Nous parlons français, anglais et wolof.

## Prestations et rendez-vous

- [Prestations et tarifs](https://atelier-rivage.example/prestations): d'une frange à une couleur complète
- [Prendre rendez-vous](https://rdv.atelier-rivage.example/): choisissez la coiffeuse et l'heure
- [L'équipe](https://atelier-rivage.example/equipe): qui fait quoi

## Conditions

- [Annulations](https://atelier-rivage.example/annulations): gratuites jusqu'à 24 heures avant ; ensuite, la moitié est due
- [Cartes cadeaux](https://atelier-rivage.example/cadeaux): tout montant, valables 12 mois

## Pour les agents IA

- [Boîte de réception pour agents](https://boite.atelier-rivage.example/.well-known/agent-inbox.json): questions et demandes de rendez-vous

## Optional

- [Conseils pour vos cheveux](https://atelier-rivage.example/blog)`,
      },
      {
        id: "clinic",
        label: "Cabinet",
        name: "Cabinet : dentiste, kiné, vétérinaire ou thérapeute",
        note: "Soins, tarifs et prise de rendez-vous ; jamais rien sur les patients. Pas encore d'accès, donc pas de section pour les agents.",
        file: `# Cabinet dentaire des Érables

> Cabinet dentaire familial : contrôles, détartrage, soins, blanchiment et dentisterie pour enfants. Ouvert du lundi au samedi.

Nouveaux patients bienvenus. En cas de forte douleur ou de gonflement, appelez-nous avant de venir.

## Soins et rendez-vous

- [Soins et tarifs](https://dentaire-erables.example/soins): fourchettes de prix par soin
- [Prendre rendez-vous](https://dentaire-erables.example/rendez-vous): contrôles et détartrage en ligne ; le reste après un contrôle
- [Votre premier rendez-vous](https://dentaire-erables.example/premiere-visite): quoi apporter, combien de temps
- [Assurances et paiement](https://dentaire-erables.example/assurances): les régimes et mutuelles acceptés

## Conditions

- [Annulations](https://dentaire-erables.example/annulations): merci de prévenir 24 heures avant
- [Urgences](https://dentaire-erables.example/contact): aide le jour même pour la douleur et les accidents

## Optional

- [Nos dentistes](https://dentaire-erables.example/equipe)`,
      },
      {
        id: "shop",
        label: "Boutique",
        name: "Boutique en ligne ou de quartier",
        note: "Collections, livraison et retours, et les profils d'achat que beaucoup de plateformes publient pour vous.",
        file: `# Thés de la Lagune

> Thés en vrac et accessoires, emballés à la commande. Livraison dans de nombreux pays depuis notre propre entrepôt.

Livraison offerte à partir d'un montant affiché au paiement. Les commandes passées avant 14 h partent le jour ouvré même.

## Boutique

- [Thés noirs et verts](https://thes-lagune.example/collections/thes)
- [Théières et tasses](https://thes-lagune.example/collections/accessoires)
- [Coffrets cadeaux](https://thes-lagune.example/collections/coffrets)

## Commandes et conditions

- [Livraison](https://thes-lagune.example/livraison): délais et frais par pays
- [Retours](https://thes-lagune.example/retours): 30 jours, produit non ouvert
- [Suivre une commande](https://thes-lagune.example/suivi)
- [Moyens de paiement](https://thes-lagune.example/paiement): carte, portefeuilles et virement

## Pour les agents IA

- [Profil de boutique (UCP)](https://thes-lagune.example/.well-known/ucp): catalogue et achat
- [Serveur MCP](https://thes-lagune.example/api/mcp): chercher des produits, remplir un panier

## Optional

- [Guides d'infusion](https://thes-lagune.example/blog)`,
      },
      {
        id: "trades",
        label: "Artisans",
        name: "Artisans : plombier, électricien, travaux ou ménage",
        note: "Où vous intervenez, ce que coûte un déplacement, et comment demander un devis ou une urgence.",
        file: `# Dubois Plomberie Chauffage

> Plomberie, chauffage et dépannage de chaudières pour particuliers et petites entreprises, en ville et dans les communes voisines.

Déplacement à prix fixe, puis un devis avant de commencer. Urgences tous les jours, de 7 h à 22 h.

## Prestations et devis

- [Prestations et zones d'intervention](https://dubois-plomberie.example/prestations): réparations, installations, entretien
- [Tarifs et frais de déplacement](https://dubois-plomberie.example/tarifs)
- [Demander un devis](https://dubois-plomberie.example/devis): des photos nous aident à chiffrer
- [Urgences](https://dubois-plomberie.example/urgences): horaires et comment nous joindre

## Conditions

- [Qualifications et assurances](https://dubois-plomberie.example/assurances)
- [Notre garantie](https://dubois-plomberie.example/garantie): 12 mois pièces et main-d'œuvre

## Pour les agents IA

- [Boîte de réception pour agents](https://boite.dubois-plomberie.example/.well-known/agent-inbox.json): demandes de devis et messages

## Optional

- [Chantiers récents](https://dubois-plomberie.example/chantiers)`,
      },
      {
        id: "stay",
        label: "Hébergement",
        name: "Hôtel, chambres d'hôtes ou gîte",
        note: "Chambres et tarifs, réservation, horaires d'arrivée et les règles que les clients demandent.",
        file: `# Chambres d'hôtes Les Tilleuls

> Cinq chambres dans une ferme rénovée, petit-déjeuner compris, sentiers de randonnée au départ de la maison.

Arrivée à partir de 15 h, départ avant 11 h. Chiens acceptés dans deux chambres.

## Chambres et réservation

- [Chambres et tarifs](https://les-tilleuls.example/chambres): photos et ce qui est compris
- [Réserver](https://les-tilleuls.example/reserver): disponibilités en direct
- [Venir](https://les-tilleuls.example/acces): en voiture, en train ou en navette

## Conditions

- [Annulations](https://les-tilleuls.example/annulations): gratuites jusqu'à 7 jours avant l'arrivée
- [Animaux](https://les-tilleuls.example/animaux)

## Pour les agents IA

- [Boîte de réception pour agents](https://boite.les-tilleuls.example/.well-known/agent-inbox.json): questions, groupes et demandes de réservation

## Optional

- [Balades autour](https://les-tilleuls.example/balades)`,
      },
      {
        id: "classes",
        label: "Cours",
        name: "Cours : salle de sport, yoga, danse ou musique",
        note: "Le planning, les abonnements et le premier cours. Pas encore d'accès, donc pas de section pour les agents.",
        file: `# Studio Souffle Yoga

> Studio de yoga et de pilates, cours pour débutants et confirmés, matin et soir, sept jours sur sept.

Premier cours offert. Tapis et briques fournis.

## Cours et abonnements

- [Planning](https://studio-souffle.example/planning): tous les cours de la semaine
- [Abonnements et cartes de cours](https://studio-souffle.example/tarifs)
- [Réserver un cours](https://studio-souffle.example/reserver)
- [Votre premier cours](https://studio-souffle.example/premier-cours): quelle tenue, quand arriver

## Conditions

- [Annulations](https://studio-souffle.example/annulations): jusqu'à 4 heures avant le cours

## Optional

- [Formation de professeurs](https://studio-souffle.example/formation)`,
      },
      {
        id: "professional",
        label: "Professions libérales",
        name: "Professions libérales : comptable, avocat, agence ou conseil",
        note: "Ce que vous faites, pour qui, à quel prix, et comment commencer.",
        file: `# Cabinet Mbaye & Laurent

> Expertise comptable, déclarations fiscales et paie pour indépendants et petites entreprises.

Nous travaillons en français, en anglais et en wolof. Forfaits mensuels fixes ; un premier appel de 20 minutes est offert.

## Prestations

- [Prestations et honoraires](https://mbaye-laurent.example/prestations): forfaits mensuels et missions ponctuelles
- [Réserver un premier appel](https://mbaye-laurent.example/rendez-vous)
- [Quoi préparer](https://mbaye-laurent.example/documents): les documents pour le premier rendez-vous

## Conditions

- [Lettre de mission et conditions](https://mbaye-laurent.example/conditions)
- [Confidentialité](https://mbaye-laurent.example/confidentialite)

## Pour les agents IA

- [Boîte de réception pour agents](https://boite.mbaye-laurent.example/.well-known/agent-inbox.json): questions et demandes de devis

## Optional

- [Calendrier fiscal de l'année](https://mbaye-laurent.example/calendrier)`,
      },
      {
        id: "template",
        label: "Modèle",
        name: "Un modèle vierge",
        note: "Remplacez chaque {partie entre accolades} et supprimez les lignes inutiles.",
        file: `# {Nom de votre entreprise}

> {Ce que vous faites, et où, en une ligne.}

{Facultatif : horaires, zones desservies, langues parlées, moyens de paiement.}

## {Prestations | Boutique | Venir et réserver}

- [{Prestations et tarifs}](https://{votredomaine}/{page}): {une courte note}
- [{Horaires et accès}](https://{votredomaine}/{page})
- [{Réserver ou commander}](https://{votre adresse de réservation ou de boutique})

## Conditions

- [{Annulations, livraison ou retours}](https://{votredomaine}/{page})

## Pour les agents IA

- [{Boîte de réception pour agents, serveur MCP ou profil de boutique}](https://{son adresse}): {ce qu'il reçoit}

## Optional

- [{À propos}](https://{votredomaine}/{page})`,
      },
    ],
    howH: "Comment utiliser un exemple",
    how: [
      "Copiez l'exemple le plus proche, puis changez le nom, le résumé et chaque adresse.",
      "Ne gardez que ce qui est vrai pour vous, et liez des pages qui existent déjà.",
      "Déposez-le sous le nom llms.txt à la racine de votre site, pour qu'il s'ouvre à votresite.com/llms.txt.",
      "Vérifiez-le avec le [validateur llms.txt](@tool:llms-txt) et corrigez chaque ligne signalée.",
    ],
    generator:
      "Ou partez de votre propre site : le [générateur de llms.txt](@tool:llms-txt-generator) écrit une première version à partir de ce qu'il dit déjà.",
    doorsH: "La section « Pour les agents IA »",
    doors: [
      "N'y mettez que des accès qui fonctionnent aujourd'hui : une boîte de réception pour agents, un serveur MCP, le profil d'achat d'une boutique. Pas encore d'accès ? Retirez la section. Une [boîte de réception pour agents](@start) vous en donne un.",
      "## Optional est le nom que le format donne, par convention, aux liens qu'un lecteur peut sauter ; il reste donc en anglais dans toutes les langues.",
    ],
    faqs: [
      {
        q: "Que met une petite entreprise dans son llms.txt ?",
        a: "Votre nom en titre #, une phrase sur ce que vous faites et où, puis des liens vers les pages utiles aux clients : prestations et tarifs, horaires et adresse, réservation, conditions. Ajoutez vos accès pour agents si vous en avez.",
      },
      {
        q: "Dans quelle langue l'écrire ?",
        a: "Dans celle de vos clients, la même que votre site. Les assistants lisent de nombreuses langues.",
      },
      {
        q: "Puis-je indiquer ma plateforme de réservation ou WhatsApp ?",
        a: "Oui, sous forme de liens avec une note : - [Réserver une table](https://…): jusqu'à 8 personnes (sans espace avant les deux-points, c'est le format). Uniquement des adresses publiques, jamais de liens privés ni de contacts du personnel.",
      },
      {
        q: "Où le mettre sur Wix, Shopify ou WordPress ?",
        a: "Wix peut le créer pour vous ; sur WordPress, Yoast et AIOSEO ; beaucoup de boutiques Shopify en servent déjà un. Ailleurs, déposez un fichier nommé llms.txt à la racine.",
      },
    ],
  },

  payments: {
    title: "Paiement agentique et paiement assisté par IA · Surfing Dog",
    description:
      "Un assistant IA remplit le panier ou réserve, et la personne valide le paiement. Fonctionnement, normes (cartes, portefeuilles, UCP, ACP, AP2, x402).",
    h1: "Paiement assisté par agent IA : définition et fonctionnement",
    intro:
      "Un paiement qu'un assistant IA lance ou termine pour une personne, qui continue de le valider. Voici comment cela marche aujourd'hui et ce qu'une petite entreprise peut faire.",
    short: "Paiement assisté par IA",
    idea: "L'assistant remplit le panier.\nLa personne valide. Vous êtes payé.",
    coverAlt:
      "L'assistant d'un client remplit un panier et demande à la personne de valider. Elle valide sur son téléphone, un jeton limité part vers l'entreprise, et l'entreprise est payée.",
    answer:
      "C'est un paiement qu'un assistant IA prépare pour une personne, qui le valide toujours d'un geste, avec une clé d'accès ou l'appli de sa banque. L'entreprise est payée par son prestataire habituel, et l'assistant n'a jamais besoin d'un numéro de carte.",
    kindsH: "Assisté ou agentique ?",
    kinds: [
      {
        name: "Assisté par un agent",
        says: "L'assistant cherche, remplit le panier ou bloque le créneau. La personne valide le paiement, à chaque fois.",
      },
      {
        name: "Agentique",
        says: "L'agent paie seul, dans des limites fixées à l'avance par la personne : une boutique, un montant, une date.",
      },
    ],
    kindsSource:
      "Le cabinet d'études Forrester a posé cette distinction en [novembre 2025](https://www.forrester.com/blogs/the-race-to-agentic-payments-in-us-b2c-e-commerce-where-we-are-now/), en anglais.",
    stepsH: "Comment ça marche",
    steps: [
      "L'assistant trouve ce que veut la personne, avec le prix : une table, une coupe, un produit.",
      "Il remplit le panier ou bloque le créneau, et demande à la personne de valider.",
      "La personne valide d'un geste, avec une clé d'accès ou l'appli de sa banque. Cette validation devient un jeton ou un mandat, limité à une entreprise, un montant ou une durée.",
      "Votre paiement en ligne ou votre prestataire vérifie le jeton, et vous êtes payé comme d'habitude. L'assistant ne voit jamais de numéro de carte.",
    ],
    standardsH: "Les normes dont vous entendrez parler",
    standardsCols: ["Nom", "Ce que c'est"],
    standards: [
      {
        name: "Jetons des réseaux de cartes",
        what: "Visa Intelligent Commerce et Mastercard Agent Pay : des jetons que les réseaux de cartes émettent pour les agents, via votre prestataire de paiement.",
      },
      {
        name: "Portefeuilles et applis bancaires",
        what: "Là où la personne valide, avec une clé d'accès ou son empreinte, un paiement préparé par un assistant.",
      },
      {
        name: "Mandats bancaires",
        what: "Des paiements de compte à compte avec des limites fixées une fois, comme Pix Automático, UPI AutoPay, PayTo ou le prélèvement SEPA. Qu'un agent puisse en utiliser un dépend du système et de votre banque.",
      },
      {
        name: "UCP",
        what: "Universal Commerce Protocol : le profil d'achat d'une boutique pour les agents. Ses moyens de paiement indiquent comment un agent peut payer.",
        href: "https://ucp.dev",
      },
      {
        name: "ACP",
        what: "Agentic Commerce Protocol : un tunnel d'achat pour agents, avec un paiement délégué via le prestataire de la boutique.",
        href: "https://www.agenticcommerce.dev",
      },
      {
        name: "AP2",
        what: "Agent Payments Protocol : des mandats signés par la personne pour qu'un agent paie dans certaines limites.",
        href: "https://ap2-protocol.org",
      },
      {
        name: "x402",
        what: "Le paiement par HTTP, surtout en stablecoins. Aujourd'hui, il convient mieux aux logiciels et aux API qu'à un salon ou une boutique.",
        href: "https://www.x402.org",
      },
    ],
    standardsNote:
      "Tout cela change de mois en mois. Écrit en octobre 2026 ; demandez à votre prestataire avant de choisir.",
    doH: "Ce qu'une petite entreprise peut faire dès maintenant",
    do: [
      "Dites sur votre site comment vous êtes payé : tout de suite, avec un acompte, sur place ou sur facture. Un assistant le lit avant de s'engager au nom de la personne.",
      "Envoyez un lien de paiement vers votre propre page de paiement. Cela marche aujourd'hui avec tout assistant : l'agent fait le reste, et une personne paie.",
      "Demandez à votre prestataire de paiement quels jetons pour agents et quels portefeuilles il accepte, et dans quels pays.",
      "Si vous vendez en ligne, demandez à votre plateforme si elle publie un profil d'achat (UCP ou ACP) pour votre boutique. Le [vérificateur UCP et ACP](@tool:ucp) montre ce qui existe.",
    ],
    counts: {
      h: "Dans notre annuaire",
      line: "Sur les {checked} sites d'entreprises que nous avons vérifiés, {pay} encaissent par un accès qu'un agent peut utiliser. Compté le {date}.",
      link: "Les voir dans les classements",
      wait: "Les chiffres en direct de notre annuaire s'affichent ici.",
      none: "Les chiffres sont indisponibles pour le moment.",
    },
    next: "voyez si un assistant trouve comment vous payer.",
    cover: {
      assistant: "Son assistant",
      person: "La personne",
      business: "Votre entreprise",
      approve: "Valider ?",
      token: "Une boutique · un montant",
      paid: "Payé",
    },
    faqs: [
      {
        q: "Quelle différence entre paiement assisté et paiement agentique ?",
        a: "Dans le paiement assisté, la personne le valide, par exemple d'un geste ou avec une clé d'accès. Dans le paiement agentique, l'agent paie seul dans des limites fixées à l'avance. Forrester a posé cette distinction en novembre 2025.",
      },
      {
        q: "ChatGPT ou un autre assistant peut-il payer ?",
        a: "Certains assistants remplissent un panier ou lancent un paiement, et certains réseaux de paiement laissent un agent payer avec un jeton validé par la personne. L'offre varie selon l'assistant, le pays et le prestataire.",
      },
      {
        q: "Est-ce sûr qu'un agent paie mon entreprise ?",
        a: "L'agent n'a pas besoin du numéro de carte : jetons, portefeuilles et mandats sont limités à un commerçant, un montant ou une durée, et la personne les valide. Vous êtes payé par votre prestataire habituel.",
      },
      {
        q: "Faut-il un nouveau logiciel pour l'accepter ?",
        a: "Pour commencer, en général non : un lien de paiement sur votre propre site fonctionne avec tout assistant. Les jetons pour agents et les portefeuilles passent par votre prestataire ; demandez-lui lesquels il prend en charge.",
      },
    ],
  },
};
