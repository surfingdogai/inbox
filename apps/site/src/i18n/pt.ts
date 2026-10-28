import type { Dict } from "./types";

/**
 * Português com você, puxado para o Brasil mas sem regionalismos fortes: escrito em português, não
 * traduzido palavra por palavra.
 */
export const pt: Dict = {
  lang: "pt",
  ui: {
    skip: "Pular para o conteúdo",
    langs: "Idiomas",
    home: "Início",
    inShort: "Em resumo",
    questions: "Perguntas",
    related: "Relacionados",
    updated: "Atualizado em {date}",
    copy: "Copiar",
    copied: "Copiado",
    copyFailed: "Selecione o texto",
    wholeSite: "Verifique o site inteiro",
    wholeSiteLine: "o que um assistente consegue fazer com o seu negócio, e o que falta.",
    getInbox: "Crie sua caixa de entrada para agentes",
    nav: {
      "Check a business": "Verificar um negócio",
      Guides: "Guias",
      Directory: "Diretório",
      Leaderboards: "Rankings",
      "For businesses": "Para negócios",
      "For agents": "Para agentes",
      Rules: "Regras",
      About: "Sobre",
      FAQ: "Perguntas frequentes",
      "How it works": "Como funciona",
      "Spam filter": "Filtro de spam",
      "Try it": "Experimente",
      Assistants: "Assistentes",
      Integrations: "Integrações",
      Requests: "Pedidos",
      Sponsors: "Patrocinadores",
      Docs: "Documentação",
      Technical: "Técnico",
      Site: "Site",
      "All pages": "Todas as páginas",
      "Switch theme": "Mudar o tema",
      Menu: "Menu",
      Theme: "Tema",
      Day: "Dia",
      Night: "Noite",
      Install: "Instalar",
      Specs: "Especificações",
      Support: "Suporte",
      Privacy: "Privacidade",
      Terms: "Termos",
      Developers: "Desenvolvedores",
      Legal: "Jurídico",
      "How the network works": "Como a rede funciona",
      "Free tools": "Ferramentas grátis",
      Search: "Buscar",
      Inbox: "Caixa de entrada",
      "Trust network": "Rede de confiança",
      Footer: "Rodapé",
      "Open doors to the agentic internet.": "Portas abertas para a internet dos agentes.",
      "Open source under the MIT licence.": "Código aberto sob a licença MIT.",
    },
  },

  hub: {
    title: "Ferramentas grátis para preparar seu site para agentes de IA",
    description:
      "Verifique grátis seu llms.txt, robots.txt, servidor MCP, perfis UCP e ACP e caixa de entrada para agentes, com guias claros para pequenos negócios.",
    h1: "Ferramentas grátis para deixar seu negócio pronto para agentes de IA",
    intro:
      "Verifique uma coisa, ou o site inteiro. Cada ferramenta mostra o que falta e como corrigir, em palavras simples. Sem cadastro.",
    short: "Ferramentas e guias",
    idea: "Verifique uma coisa,\nou o site inteiro.",
    coverAlt:
      "Sete blocos, um para cada ferramenta grátis: o site inteiro, llms.txt, o gerador de llms.txt, robots.txt, MCP, UCP e ACP, e a caixa de entrada para agentes. Uma luz passa por cada um.",
    toolsH: "Ferramentas",
    tools: {
      check: {
        name: "Seu negócio está pronto para agentes de IA? Verifique tudo",
        line: "Seu site inteiro, lido como o assistente de um cliente leria: o que ele consegue fazer ali, e o que falta.",
      },
      "llms-txt": {
        name: "Validador de llms.txt",
        line: "Cada erro com o número da linha e a correção, e as portas para onde o seu arquivo leva os agentes.",
      },
      "llms-txt-generator": {
        name: "Gerador de llms.txt",
        line: "Um llms.txt feito com o que o seu site já diz, pronto para revisar, verificar e publicar.",
      },
      "ai-crawlers": {
        name: "Verificador de rastreadores de IA",
        line: "Quais rastreadores de empresas de IA o seu robots.txt deixa entrar, quais podem treinar com as suas páginas e a linha que decide.",
      },
      "mcp-server": {
        name: "Teste de servidor MCP",
        line: "O que o seu servidor MCP oferece a um assistente, conferido com a especificação atual, sem chamar nenhuma ferramenta.",
      },
      ucp: {
        name: "Verificador UCP e ACP",
        line: "Se os agentes de IA encontram os perfis de compra da sua loja, e o que falta para eles comprarem.",
      },
      "agent-inbox": {
        name: "Verificador de caixa de entrada para agentes",
        line: "O manifesto da caixa de entrada para agentes de um negócio, campo a campo pela especificação publicada, e se cada porta responde.",
      },
    },
    spec: {
      name: "Verificar um manifesto ou um recibo",
      line: "Cole o manifesto de uma caixa de entrada para agentes ou um recibo assinado e confira com a especificação, no seu navegador.",
    },
    guidesH: "Guias",
    guides: {
      "validate-llms-txt": "Sete passos curtos, com os erros mais comuns e como corrigir cada um.",
      "llms-txt-examples": "Arquivos prontos para copiar: restaurante, salão, clínica, loja, serviços e mais.",
      "ai-agent-assisted-payments":
        "Como um assistente paga por uma pessoa, os padrões por trás disso e o que fazer agora.",
    },
    checklist: {
      name: "O checklist de prontidão para agentes de IA",
      line: "oito guias, um para cada coisa que a verificação conta.",
      names: {
        "ai-assistant-bookings": "Agendamentos",
        "sell-through-ai-assistants": "Vendas",
        "ai-assistant-messages-and-quotes": "Mensagens e orçamentos",
        "ai-assistant-payments": "Pagamentos",
        "business-details-for-ai": "Seus dados legíveis",
        "findable-agent-doors": "Portas fáceis de achar",
        "llms-txt": "llms.txt",
        "robots-txt-ai-agents": "robots.txt",
      },
    },
    end: "Não sabe por onde começar? [Verifique o site inteiro](@tool:check): você vê quais destas importam para o seu negócio.",
    cover: { site: "site" },
  },

  validate: {
    title: "Como validar seu llms.txt passo a passo · Surfing Dog",
    description:
      "Verifique seu llms.txt em cinco minutos: abra, confira a primeira linha, corrija os links e use um validador. Com os erros mais comuns e como corrigir.",
    h1: "Como validar seu llms.txt",
    intro: "Sete passos curtos, em ordem. Quase todos os problemas estão na primeira linha ou nos links.",
    short: "Como validar seu llms.txt",
    idea: "A linha 1 é o seu nome.\nCada link é [nome](https://…).",
    coverAlt:
      "Um llms.txt é conferido linha a linha. O nome na linha 1 e o resumo passam; um endereço solto na linha 5 vira um link Markdown, e o arquivo fica válido.",
    form: {
      title: "Verifique seu llms.txt agora",
      label: "Seu site",
      placeholder: "seunegocio.com",
      button: "Verificar",
      note: "Grátis e sem cadastro. Lemos o seu /llms.txt como um assistente leria e mostramos cada problema com a linha e a correção.",
    },
    stepsH: "Sete passos",
    steps: [
      {
        name: "Abra o arquivo",
        text: "Abra seusite.com/llms.txt no navegador. Deve aparecer texto, não sua página inicial nem uma página de erro.",
      },
      {
        name: "Confira a linha 1",
        text: "A linha 1 é o seu nome depois de um #: `# Seu negócio`. É a única exigência do formato.",
      },
      {
        name: "Inclua um resumo",
        text: "Logo abaixo, uma linha que começa com >: o que você faz e onde. É opcional, mas ajuda.",
      },
      {
        name: "Faça de cada link um link",
        text: "Sob cada título ##, um link por linha: `- [Nome](https://…): uma nota curta`. Com endereços https completos.",
      },
      {
        name: "Use um validador",
        text: "Digite seu site no validador lá em cima e corrija cada linha que ele apontar.",
      },
      {
        name: "Veja o que o Lighthouse diz",
        text: "Opcional: no Chrome, abra o DevTools, depois o Lighthouse, marque a categoria Agentic Browsing e execute.",
      },
      {
        name: "Verifique de novo",
        text: "Publique o arquivo corrigido e verifique outra vez. Um cache pode mostrar o arquivo antigo por um tempo.",
      },
    ],
    mail: {
      label: "Enviar estes passos para quem cuida do meu site",
      subject: "Nosso llms.txt: sete verificações",
      intro: "Olá,\n\nVocê pode conferir o nosso llms.txt com estes sete passos?",
      validator: "Digite o site em {url} e corrija cada linha que ele apontar.",
      outro: "O guia, com os erros mais comuns e como corrigir:",
    },
    errorsH: "Erros comuns e como corrigir",
    errorsCols: ["O que você vê", "Como corrigir"],
    errors: [
      {
        problem: "Sua página inicial, ou uma página de “não encontrado”, em /llms.txt",
        fix: "Ainda não há arquivo. Envie um arquivo chamado llms.txt para a raiz do site, ou ative na sua plataforma.",
      },
      {
        problem: "A linha 1 não é `# Seu nome`",
        fix: "Ponha na linha 1 o nome do seu negócio depois de um # e um espaço. Antes dela, só linhas em branco.",
      },
      {
        problem: "`- Menu: https://…`",
        fix: "Escreva como link: `- [Menu](https://…): almoço e jantar`. O Lighthouse do Chrome reprova um arquivo sem nenhum link Markdown.",
      },
      {
        problem: "Títulos `###`, ou um título entre o seu nome e as seções",
        fix: "Deixe um único # para o seu nome e use ## para cada seção.",
      },
      {
        problem: "`http://` ou `/menu`",
        fix: "Use o endereço completo com https: `https://seunegocio.com/menu`.",
      },
      { problem: "Um link leva a uma página que não existe", fix: "Corrija o endereço ou tire a linha." },
      {
        problem: "Seu robots.txt bloqueia /llms.txt",
        fix: "Libere: leitores que respeitam o robots.txt não leem um arquivo bloqueado. O [verificador de rastreadores de IA](@tool:ai-crawlers) mostra a linha.",
      },
      {
        problem: "Erro 403 ou 429, ou uma página de “verificando seu navegador”",
        fix: "Sua hospedagem ou seu firewall barra os leitores. Peça para liberar o /llms.txt.",
      },
      { problem: "Caracteres estranhos, como Ã© no lugar de é", fix: "Salve o arquivo como texto puro em UTF-8." },
    ],
    sampleH: "Como é um arquivo válido",
    sampleIntro: "Curto, com o seu nome primeiro e um link por linha:",
    sample: `# Padaria Trigo Bom

> Padaria e café de fermentação natural, doces e bolos sob encomenda. Abrimos todos os dias a partir das 7h.

## Visite e encomende

- [Produtos e preços](https://trigobom.example/produtos): pães, doces e café
- [Encomendar um bolo](https://trigobom.example/bolos): com três dias de antecedência
- [Horário e como chegar](https://trigobom.example/visite)

## Optional

- [Nossa história](https://trigobom.example/historia)`,
    sampleMore: "[Mais exemplos](@llms-txt-examples): restaurante, salão, clínica, loja, serviços e mais.",
    limitsH: "O que um arquivo válido faz, e o que não faz",
    limits: [
      "A Busca do Google não usa o llms.txt. O Lighthouse do Chrome o audita, e algumas ferramentas de IA o leem.",
      "Um arquivo válido ajuda um assistente a entender o seu negócio. Para que ele possa perguntar, agendar ou pedir, você precisa de uma porta: uma ferramenta, uma API ou uma [caixa de entrada para agentes](@start) que receba o pedido. Mais em [o que o llms.txt faz, e o que não faz](@guide:llms-txt), em inglês.",
    ],
    cover: { line: "Linha", name: "nome", summary: "resumo", link: "link corrigido", verdict: "llms.txt válido" },
    faqs: [
      {
        q: "O que torna um llms.txt válido?",
        a: "Segundo o llmstxt.org, só uma coisa é obrigatória: um título # com o seu nome. Um bom arquivo acrescenta um resumo com > e seções ## com links [nome](url).",
      },
      {
        q: "O Google verifica meu llms.txt?",
        a: "A Busca do Google não o usa. O Lighthouse do Chrome (13.3 ou mais novo) verifica em Agentic Browsing: um título #, pelo menos 50 caracteres e um link Markdown.",
      },
      {
        q: "Preciso também de um llms-full.txt?",
        a: "Não. O llms-full.txt é um costume da comunidade, não faz parte da proposta llms.txt.",
      },
      {
        q: "Posso colocar o llms.txt numa pasta?",
        a: "Sim. Desde a versão 2 da proposta (agosto de 2026), um arquivo num caminho como /docs/llms.txt vale para as páginas abaixo desse caminho.",
      },
    ],
  },

  examples: {
    title: "Exemplos de llms.txt para pequenos negócios · Surfing Dog",
    description:
      "Exemplos de llms.txt para copiar: restaurante, salão, clínica, loja, serviços, hospedagem e mais, no formato do llmstxt.org. Copie, edite e verifique.",
    h1: "Exemplos de llms.txt para pequenos negócios",
    intro: "Escolha o mais parecido com o seu negócio, copie, troque textos e endereços e verifique.",
    short: "Exemplos de llms.txt",
    idea: "Um restaurante, um salão, um encanador:\num llms.txt para cada um, pronto para copiar.",
    coverAlt:
      "Blocos de um restaurante, um salão, um prestador de serviços e uma loja acendem um de cada vez, e ao lado um llms.txt se reescreve para cada um: o nome, a primeira seção e o primeiro link.",
    made: "Todos os nomes e endereços são inventados. Endereços terminados em .example não podem ser de ninguém.",
    jump: "Exemplos",
    kinds: [
      {
        id: "restaurant",
        label: "Restaurante",
        name: "Restaurante, café ou bar",
        note: "Menu, horário, reservas e as políticas que os clientes perguntam.",
        file: `# Bistrô Jabuticaba

> Bistrô de cozinha sazonal, pratos para dividir e vinhos naturais. Abrimos de terça a domingo, no almoço e no jantar.

Grupos pequenos não precisam reservar; a partir de cinco pessoas, reserve. Pratos vegetarianos e sem glúten todos os dias; avise sobre alergias ao reservar.

## Visite e reserve

- [Menu e preços](https://jabuticaba.example/menu): almoço e jantar, muda toda semana
- [Horário e como chegar](https://jabuticaba.example/visite): endereço, mapa e transporte público
- [Reservar uma mesa](https://reservas.jabuticaba.example/): on-line, até 8 pessoas
- [Eventos fechados](https://jabuticaba.example/eventos): grupos de 10 a 40, orçamento sob consulta

## Políticas

- [Cancelamentos e sinal](https://jabuticaba.example/politicas): cancelamento grátis até 24 horas antes
- [Alergênicos](https://jabuticaba.example/alergenicos): prato a prato

## Para agentes de IA

- [Caixa de entrada para agentes](https://caixa.jabuticaba.example/.well-known/agent-inbox.json): mensagens, orçamentos e reservas de mesa
- [Servidor MCP](https://caixa.jabuticaba.example/mcp): ver disponibilidade e pedir reserva

## Optional

- [Nossa história](https://jabuticaba.example/historia)`,
      },
      {
        id: "salon",
        label: "Salão",
        name: "Salão de beleza, cabeleireiro ou barbearia",
        note: "Serviços com preço, a página de agendamento que você já usa e a regra de cancelamento.",
        file: `# Studio Ipê Cabelo e Beleza

> Salão de beleza: corte, coloração, tranças, unhas e sobrancelhas. Abrimos de terça a sábado; às quintas, até mais tarde.

Melhor com hora marcada; sem hora quando há cadeira livre. Atendemos em português, inglês e espanhol.

## Serviços e agendamento

- [Serviços e preços](https://studioipe.example/servicos): de um acerto de franja a coloração completa
- [Agendar](https://agenda.studioipe.example/): escolha o profissional e o horário
- [Nossa equipe](https://studioipe.example/equipe): quem faz o quê

## Políticas

- [Cancelamentos](https://studioipe.example/cancelamentos): grátis até 24 horas antes; depois, cobramos metade
- [Vale-presente](https://studioipe.example/vale-presente): qualquer valor, válido por 12 meses

## Para agentes de IA

- [Caixa de entrada para agentes](https://caixa.studioipe.example/.well-known/agent-inbox.json): perguntas e pedidos de agendamento

## Optional

- [Dicas para o seu cabelo](https://studioipe.example/blog)`,
      },
      {
        id: "clinic",
        label: "Clínica",
        name: "Clínica: dentista, fisioterapia, veterinária ou terapia",
        note: "Tratamentos, valores e como agendar; nunca nada sobre pacientes. Ainda sem porta, então sem seção para agentes.",
        file: `# Odonto Aroeira

> Clínica odontológica para a família: consultas, limpeza, restaurações, clareamento e odontopediatria. Abrimos de segunda a sábado.

Novos pacientes são bem-vindos. Em caso de dor forte ou inchaço, ligue antes de vir.

## Tratamentos e agendamento

- [Tratamentos e valores](https://odontoaroeira.example/tratamentos): faixas de preço por tratamento
- [Agendar consulta](https://odontoaroeira.example/agendar): consultas e limpeza on-line; o resto, depois de uma avaliação
- [Sua primeira consulta](https://odontoaroeira.example/primeira-consulta): o que trazer e quanto tempo leva
- [Convênios e parcelamento](https://odontoaroeira.example/convenios): planos que aceitamos

## Políticas

- [Cancelamentos](https://odontoaroeira.example/cancelamentos): avise com 24 horas de antecedência
- [Urgências](https://odontoaroeira.example/contato): atendimento no mesmo dia para dor e acidentes

## Optional

- [Nossos dentistas](https://odontoaroeira.example/equipe)`,
      },
      {
        id: "shop",
        label: "Loja",
        name: "Loja on-line ou de bairro",
        note: "Coleções, entrega e trocas, e os perfis de compra que muitas plataformas publicam por você.",
        file: `# Torra Fina Cafés

> Cafés especiais torrados toda semana, em grãos ou moídos, e tudo para preparar. Enviamos para vários países.

Envio grátis acima de um valor indicado no pagamento. Pedidos até as 14h saem no mesmo dia útil.

## Loja

- [Cafés](https://torrafina.example/cafes): origem, torra e notas
- [Cafeteiras e moedores](https://torrafina.example/equipamentos)
- [Assinatura](https://torrafina.example/assinatura): a cada 2 ou 4 semanas

## Pedidos e políticas

- [Entrega](https://torrafina.example/entrega): prazos e custos por país
- [Trocas e devoluções](https://torrafina.example/trocas): 30 dias, sem abrir
- [Rastrear pedido](https://torrafina.example/rastreio)
- [Formas de pagamento](https://torrafina.example/pagamento): cartão, carteiras digitais e transferência

## Para agentes de IA

- [Perfil da loja (UCP)](https://torrafina.example/.well-known/ucp): catálogo e compra
- [Servidor MCP](https://torrafina.example/api/mcp): buscar produtos e montar o carrinho

## Optional

- [Guias de preparo](https://torrafina.example/blog)`,
      },
      {
        id: "trades",
        label: "Serviços",
        name: "Serviços: encanador, eletricista, reformas ou limpeza",
        note: "Onde você atende, quanto custa a visita e como pedir orçamento ou um atendimento de urgência.",
        file: `# Silva Reparos Hidráulicos

> Encanamento, gás e aquecedores para casas e pequenos negócios, na cidade e nas cidades vizinhas.

Taxa de visita fixa e orçamento antes de começar. Urgências todos os dias, das 7h às 22h.

## Serviços e orçamentos

- [Serviços e regiões atendidas](https://silvareparos.example/servicos): consertos, instalações e manutenção
- [Preços e taxa de visita](https://silvareparos.example/precos)
- [Pedir orçamento](https://silvareparos.example/orcamento): mande fotos para um preço mais certo
- [Urgências](https://silvareparos.example/urgencias): horários e como chamar

## Políticas

- [Certificados e seguro](https://silvareparos.example/certificados)
- [Garantia](https://silvareparos.example/garantia): 12 meses em peças e mão de obra

## Para agentes de IA

- [Caixa de entrada para agentes](https://caixa.silvareparos.example/.well-known/agent-inbox.json): pedidos de orçamento e mensagens

## Optional

- [Trabalhos recentes](https://silvareparos.example/trabalhos)`,
      },
      {
        id: "stay",
        label: "Hospedagem",
        name: "Hotel, pousada ou hostel",
        note: "Quartos e tarifas, reservas, horários de chegada e as regras que os hóspedes perguntam.",
        file: `# Pousada Mar de Dentro

> Pousada de oito quartos à beira da lagoa, com café da manhã incluído e trilhas a partir da porta.

Check-in a partir das 15h, check-out até as 11h. Aceitamos cães em dois quartos.

## Quartos e reservas

- [Quartos e tarifas](https://mardedentro.example/quartos): com fotos e o que está incluído
- [Reservar](https://mardedentro.example/reservar): disponibilidade em tempo real
- [Como chegar](https://mardedentro.example/como-chegar): de carro, ônibus ou transfer

## Políticas

- [Cancelamentos](https://mardedentro.example/cancelamentos): grátis até 7 dias antes da chegada
- [Animais de estimação](https://mardedentro.example/pets)

## Para agentes de IA

- [Caixa de entrada para agentes](https://caixa.mardedentro.example/.well-known/agent-inbox.json): perguntas, grupos e pedidos de reserva

## Optional

- [Passeios por perto](https://mardedentro.example/passeios)`,
      },
      {
        id: "classes",
        label: "Aulas",
        name: "Aulas: academia ou ginásio, ioga, dança ou música",
        note: "A grade de horários, os planos e a primeira visita. Ainda sem porta, então sem seção para agentes.",
        file: `# Estúdio Ginga Dança

> Escola de dança com aulas de samba, forró, salsa e dança contemporânea, para iniciantes e avançados, de manhã e à noite.

A primeira aula é grátis. Venha com roupa confortável.

## Aulas e planos

- [Grade de horários](https://estudioginga.example/horarios): todas as aulas da semana
- [Planos e pacotes de aulas](https://estudioginga.example/planos)
- [Reservar uma aula](https://estudioginga.example/reservar)
- [Sua primeira aula](https://estudioginga.example/primeira-aula): o que vestir e quando chegar

## Políticas

- [Cancelamentos](https://estudioginga.example/cancelamentos): até 4 horas antes da aula

## Optional

- [Espetáculos](https://estudioginga.example/espetaculos)`,
      },
      {
        id: "professional",
        label: "Profissionais",
        name: "Serviços profissionais: contabilidade, advocacia, agência ou consultoria",
        note: "O que você faz, para quem, quanto custa e como começar.",
        file: `# Mendes & Okafor Contabilidade

> Contabilidade, impostos e folha de pagamento para profissionais autônomos e pequenas empresas.

Atendemos em português, inglês e iorubá. Mensalidades fixas; a primeira conversa de 20 minutos é grátis.

## Serviços

- [Serviços e valores](https://mendesokafor.example/servicos): planos mensais e trabalhos avulsos
- [Agendar uma primeira conversa](https://mendesokafor.example/agendar)
- [O que preparar](https://mendesokafor.example/documentos): documentos para a primeira reunião

## Políticas

- [Termos do serviço](https://mendesokafor.example/termos)
- [Privacidade](https://mendesokafor.example/privacidade)

## Para agentes de IA

- [Caixa de entrada para agentes](https://caixa.mendesokafor.example/.well-known/agent-inbox.json): perguntas e pedidos de orçamento

## Optional

- [Calendário de impostos do ano](https://mendesokafor.example/calendario)`,
      },
      {
        id: "template",
        label: "Modelo",
        name: "Um modelo em branco",
        note: "Troque cada {parte entre chaves} e apague as linhas de que você não precisa.",
        file: `# {Nome do seu negócio}

> {O que você faz e onde, em uma linha.}

{Opcional: horários, regiões que você atende, idiomas que fala, formas de pagamento.}

## {Serviços | Loja | Visite e reserve}

- [{Serviços e preços}](https://{seudominio}/{pagina}): {uma nota curta}
- [{Horário e como chegar}](https://{seudominio}/{pagina})
- [{Agendar ou pedir}](https://{seu endereço de agendamento ou loja})

## Políticas

- [{Cancelamentos, entrega ou trocas}](https://{seudominio}/{pagina})

## Para agentes de IA

- [{Caixa de entrada para agentes, servidor MCP ou perfil da loja}](https://{endereço}): {o que recebe}

## Optional

- [{Sobre nós}](https://{seudominio}/{pagina})`,
      },
    ],
    howH: "Como usar um exemplo",
    how: [
      "Copie o exemplo mais parecido e troque o nome, o resumo e cada endereço.",
      "Mantenha só o que vale para você, e coloque links para páginas que já existem.",
      "Envie como llms.txt para a raiz do site, para que abra em seusite.com/llms.txt.",
      "Verifique com o [validador de llms.txt](@tool:llms-txt) e corrija cada linha que ele apontar.",
    ],
    generator:
      "Ou comece pelo seu próprio site: o [gerador de llms.txt](@tool:llms-txt-generator) escreve uma primeira versão com o que o seu site já diz.",
    doorsH: "A seção “Para agentes de IA”",
    doors: [
      "Liste só portas que funcionam hoje: uma caixa de entrada para agentes, um servidor MCP, o perfil de compra de uma loja. Ainda não tem nenhuma? Tire a seção. Uma [caixa de entrada para agentes](@start) dá uma a você.",
      "## Optional é o nome que o formato dá, por convenção, aos links que um leitor pode pular, por isso fica em inglês em todos os idiomas.",
    ],
    faqs: [
      {
        q: "O que um pequeno negócio coloca no llms.txt?",
        a: "Seu nome como título #, uma frase sobre o que você faz e onde, e links para as páginas que respondem aos clientes: serviços e preços, horário e localização, agendamento, políticas. Inclua suas portas para agentes, se tiver.",
      },
      {
        q: "Em que idioma escrevo?",
        a: "No idioma dos seus clientes, o mesmo do seu site. Assistentes leem muitos idiomas.",
      },
      {
        q: "Posso colocar minha plataforma de agendamento ou WhatsApp?",
        a: "Sim, como links com uma nota: - [Agendar](https://…): cortes e coloração. Só endereços públicos; nunca links privados ou contatos da equipe.",
      },
      {
        q: "Onde publico no Wix, Shopify ou WordPress?",
        a: "O Wix pode criar para você; no WordPress, Yoast e AIOSEO; muitas lojas Shopify já publicam um. Nos outros sites, envie um arquivo chamado llms.txt para a raiz.",
      },
    ],
  },

  payments: {
    title: "Pagamentos agênticos e assistidos por IA: o que são",
    description:
      "Um assistente de IA monta o carrinho ou agenda, e a pessoa aprova o pagamento. Como funciona, os padrões (cartões, carteiras, UCP, ACP, AP2, x402).",
    h1: "Pagamentos assistidos por agentes de IA: o que são e como funcionam",
    intro:
      "Um pagamento que um assistente de IA inicia ou conclui para uma pessoa, que continua aprovando. Veja como funciona hoje e o que um pequeno negócio pode fazer.",
    short: "Pagamentos assistidos por IA",
    idea: "O assistente monta o carrinho.\nA pessoa aprova. Você recebe.",
    coverAlt:
      "O assistente de um cliente monta um carrinho e pede à pessoa que aprove. A pessoa aprova no telefone, um token limitado viaja até o negócio, e o negócio recebe.",
    answer:
      "É um pagamento que um assistente de IA prepara para uma pessoa, que ainda o aprova com um toque, uma chave de acesso ou o app do banco. O negócio recebe pelo seu provedor de sempre, e o assistente nunca precisa do número do cartão.",
    kindsH: "Assistido ou agêntico?",
    kinds: [
      {
        name: "Assistido por um agente",
        says: "O assistente encontra, monta o carrinho ou guarda o horário. A pessoa aprova o pagamento, toda vez.",
      },
      {
        name: "Agêntico",
        says: "O agente paga sozinho, dentro de limites que a pessoa definiu antes: uma loja, um valor, uma data.",
      },
    ],
    kindsSource:
      "A consultoria Forrester traçou essa linha em [novembro de 2025](https://www.forrester.com/blogs/the-race-to-agentic-payments-in-us-b2c-e-commerce-where-we-are-now/), em inglês.",
    stepsH: "Como funciona",
    steps: [
      "O assistente encontra o que a pessoa quer, com o preço: uma mesa, um corte de cabelo, um produto.",
      "Ele monta o carrinho ou segura o horário, e pede à pessoa que aprove.",
      "A pessoa aprova com um toque, uma chave de acesso ou o app do banco. A aprovação vira um token ou uma autorização, limitada a um negócio, um valor ou um prazo.",
      "O seu checkout ou provedor de pagamentos confere o token, e você recebe como sempre. O assistente nunca vê o número de um cartão.",
    ],
    standardsH: "Os padrões de que você vai ouvir falar",
    standardsCols: ["Nome", "O que é"],
    standards: [
      {
        name: "Tokens das bandeiras de cartão",
        what: "Visa Intelligent Commerce e Mastercard Agent Pay: tokens que as bandeiras emitem para agentes, por meio do seu provedor de pagamentos.",
      },
      {
        name: "Carteiras digitais e apps de banco",
        what: "Onde a pessoa aprova, com uma chave de acesso ou a digital, um pagamento que um assistente preparou.",
      },
      {
        name: "Autorizações bancárias",
        what: "Pagamentos de conta para conta com limites definidos uma vez, como Pix Automático, UPI AutoPay, PayTo e o débito direto SEPA. Se um agente pode usar uma delas depende do sistema e do seu banco.",
      },
      {
        name: "UCP",
        what: "Universal Commerce Protocol: o perfil de compra de uma loja para agentes. Os meios de pagamento do perfil dizem como um agente pode pagar.",
        href: "https://ucp.dev",
      },
      {
        name: "ACP",
        what: "Agentic Commerce Protocol: checkout para agentes, com pagamento delegado pelo provedor da própria loja.",
        href: "https://www.agenticcommerce.dev",
      },
      {
        name: "AP2",
        what: "Agent Payments Protocol: autorizações que a pessoa assina para que um agente pague dentro de limites.",
        href: "https://ap2-protocol.org",
      },
      {
        name: "x402",
        what: "Pagamentos via HTTP, sobretudo em stablecoins. Hoje combina mais com software e APIs do que com um salão ou uma loja.",
        href: "https://www.x402.org",
      },
    ],
    standardsNote:
      "Isso muda de um mês para o outro. Escrito em outubro de 2026; pergunte ao seu provedor antes de escolher.",
    doH: "O que um pequeno negócio pode fazer agora",
    do: [
      "Diga no seu site como você recebe: na hora, com sinal, na chegada ou por fatura ou boleto. Um assistente lê isso antes de comprometer a pessoa.",
      "Envie um link de pagamento para o seu próprio checkout. Funciona hoje com qualquer assistente: o agente faz o resto, e uma pessoa paga.",
      "Pergunte ao seu provedor de pagamentos quais tokens para agentes e carteiras ele aceita, e em quais países.",
      "Se você vende on-line, pergunte à sua plataforma se ela publica um perfil de compra (UCP ou ACP) para a sua loja. O [verificador UCP e ACP](@tool:ucp) mostra o que existe.",
    ],
    counts: {
      h: "No nosso diretório",
      line: "Dos {checked} sites de negócios que verificamos, {pay} recebem por uma porta que um agente pode usar. Contagem de {date}.",
      link: "Ver nos rankings",
      wait: "As contagens ao vivo do nosso diretório aparecem aqui.",
      none: "As contagens não estão disponíveis agora.",
    },
    next: "veja se um assistente encontra como pagar você.",
    cover: {
      assistant: "O assistente",
      person: "A pessoa",
      business: "Seu negócio",
      approve: "Aprovar?",
      token: "Uma loja · um valor",
      paid: "Recebido",
    },
    faqs: [
      {
        q: "Qual a diferença entre pagamento assistido e agêntico?",
        a: "No assistido, a pessoa aprova, por exemplo com um toque ou uma chave de acesso. No agêntico, o agente paga sozinho dentro de limites definidos antes. A Forrester traçou essa linha em novembro de 2025.",
      },
      {
        q: "O ChatGPT ou outro assistente pode pagar?",
        a: "Alguns assistentes montam um carrinho ou iniciam um pagamento, e algumas redes de pagamento deixam um agente pagar com um token que a pessoa aprovou. O que existe muda conforme assistente, país e provedor.",
      },
      {
        q: "É seguro um agente pagar meu negócio?",
        a: "O agente não precisa do número do cartão: tokens, carteiras e autorizações valem para um lojista, um valor ou um prazo, e a pessoa aprova. Você recebe pelo seu provedor de sempre.",
      },
      {
        q: "Preciso de outro sistema para aceitar?",
        a: "Para começar, normalmente não: um link de pagamento no seu próprio site funciona com qualquer assistente. Tokens para agentes e carteiras vêm pelo seu provedor; pergunte quais ele aceita.",
      },
      {
        q: "E o Pix?",
        a: "O Pix Automático deixa a pessoa autorizar cobranças recorrentes com limites, uma vez. Se um agente pode usá-lo, e em que termos, depende do banco e do provedor; pergunte a eles.",
      },
    ],
  },
};
