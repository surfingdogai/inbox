import type { Dict } from "./types";

/**
 * Español neutro, de tú: palabras que funcionan en España y en América Latina (web, carrito,
 * fontanería o plomería), sin vosotros. Escrito en español, no traducido palabra por palabra.
 */
export const es: Dict = {
  lang: "es",
  ui: {
    skip: "Saltar al contenido",
    langs: "Idiomas",
    home: "Inicio",
    inShort: "En resumen",
    questions: "Preguntas",
    related: "Relacionado",
    updated: "Actualizado el {date}",
    copy: "Copiar",
    copied: "Copiado",
    copyFailed: "Selecciónalo",
    wholeSite: "Revisa toda tu web",
    wholeSiteLine: "qué puede hacer un asistente con tu negocio y qué falta.",
    getInbox: "Consigue tu bandeja para agentes",
    nav: {
      "Check a business": "Comprobar un negocio",
      Guides: "Guías",
      Directory: "Directorio",
      Leaderboards: "Clasificaciones",
      "For businesses": "Para negocios",
      "For agents": "Para agentes",
      Rules: "Reglas",
      About: "Quiénes somos",
      FAQ: "Preguntas frecuentes",
      "How it works": "Cómo funciona",
      "Try it": "Pruébalo",
      Assistants: "Asistentes",
      Requests: "Solicitudes",
      Sponsors: "Patrocinadores",
      Docs: "Documentación",
      Technical: "Técnico",
      Site: "Sitio",
      "All pages": "Todas las páginas",
      "Switch theme": "Cambiar tema",
      Menu: "Menú",
      Theme: "Tema",
      Day: "Día",
      Night: "Noche",
      Install: "Instalar",
      Specs: "Especificaciones",
      Support: "Ayuda",
      Privacy: "Privacidad",
      Terms: "Condiciones",
      Developers: "Desarrolladores",
      Legal: "Legal",
      "How the network works": "Cómo funciona la red",
      "Free tools": "Herramientas gratis",
      Footer: "Pie de página",
      Search: "Buscar",
      Inbox: "Bandeja",
      "Trust network": "Red de confianza",
      "Open doors to the agentic internet.": "Puertas abiertas al internet de los agentes.",
      "Open source under the MIT licence.": "Código abierto con licencia MIT.",
    },
  },

  hub: {
    title: "Herramientas gratis para preparar tu web para agentes de IA",
    description:
      "Comprueba gratis tu llms.txt, tu robots.txt, tu servidor MCP, tus perfiles UCP y ACP y tu bandeja para agentes, con guías claras para pequeños negocios.",
    h1: "Herramientas gratis para prepararte para los agentes de IA",
    intro:
      "Comprueba una cosa, o toda tu web. Cada herramienta te dice qué falta y cómo arreglarlo, en palabras claras. Sin registro.",
    short: "Herramientas y guías",
    idea: "Comprueba una cosa,\no toda tu web.",
    coverAlt:
      "Siete fichas, una por herramienta gratuita: toda la web, llms.txt, el generador de llms.txt, robots.txt, MCP, UCP y ACP, y la bandeja para agentes. Una luz las recorre una a una.",
    toolsH: "Herramientas",
    tools: {
      check: {
        name: "¿Tu negocio está listo para los agentes de IA? Revísalo entero",
        line: "Toda tu web, leída como la leería el asistente de un cliente: qué puede hacer ahí y qué falta.",
      },
      "llms-txt": {
        name: "Validador de llms.txt",
        line: "Cada error con su número de línea y cómo corregirlo, y las puertas a las que tu archivo lleva a los agentes.",
      },
      "llms-txt-generator": {
        name: "Generador de llms.txt",
        line: "Un llms.txt hecho con lo que ya dice tu web, listo para revisar, comprobar y subir.",
      },
      "ai-crawlers": {
        name: "Comprobador de rastreadores de IA",
        line: "Qué rastreadores de empresas de IA deja entrar tu robots.txt, cuáles pueden entrenar con tus páginas y qué línea lo decide.",
      },
      "mcp-server": {
        name: "Prueba de servidor MCP",
        line: "Lo que tu servidor MCP ofrece a un asistente, según la especificación actual, sin llamar a ninguna herramienta.",
      },
      ucp: {
        name: "Comprobador UCP y ACP",
        line: "Si los agentes de IA encuentran los perfiles de compra de tu tienda, y qué les falta para comprar.",
      },
      "agent-inbox": {
        name: "Comprobador de bandeja para agentes",
        line: "El manifiesto de la bandeja para agentes de un negocio, campo a campo según la especificación publicada, y si responde cada puerta.",
      },
    },
    spec: {
      name: "Comprobar un manifiesto o un recibo",
      line: "Pega el manifiesto de una bandeja para agentes o un recibo firmado y compruébalo con la especificación, en tu navegador.",
    },
    guidesH: "Guías",
    guides: {
      "validate-llms-txt": "Siete pasos cortos, con los errores más comunes y cómo arreglar cada uno.",
      "llms-txt-examples": "Archivos listos para copiar: restaurante, peluquería, clínica, tienda, oficios y más.",
      "ai-agent-assisted-payments":
        "Cómo paga un asistente por una persona, los estándares que hay detrás y qué puedes hacer ya.",
    },
    checklist: {
      name: "La lista de preparación para agentes de IA",
      line: "ocho guías, una por cada cosa que cuenta la comprobación.",
      names: {
        "ai-assistant-bookings": "Reservas",
        "sell-through-ai-assistants": "Ventas",
        "ai-assistant-messages-and-quotes": "Mensajes y presupuestos",
        "ai-assistant-payments": "Pagos",
        "business-details-for-ai": "Tus datos, legibles",
        "findable-agent-doors": "Puertas que se encuentran",
        "llms-txt": "llms.txt",
        "robots-txt-ai-agents": "robots.txt",
      },
    },
    end: "¿No sabes por dónde empezar? [Revisa toda tu web](@tool:check): verás cuáles de estas importan para tu negocio.",
    cover: { site: "web" },
  },

  validate: {
    title: "Cómo validar tu llms.txt paso a paso · Surfing Dog",
    description:
      "Revisa tu llms.txt en cinco minutos: ábrelo, mira la primera línea, corrige los enlaces y pasa un validador. Con los errores comunes y cómo arreglarlos.",
    h1: "Cómo validar tu llms.txt",
    intro: "Siete pasos cortos, en orden. Casi todos los fallos están en la primera línea o en los enlaces.",
    short: "Cómo validar tu llms.txt",
    idea: "La línea 1 es tu nombre.\nCada enlace, [nombre](https://…).",
    coverAlt:
      "Un llms.txt se revisa línea a línea. El nombre de la línea 1 y el resumen pasan; una dirección suelta en la línea 5 se convierte en un enlace Markdown, y el archivo queda válido.",
    form: {
      title: "Comprueba tu llms.txt ahora",
      label: "Tu web",
      placeholder: "tunegocio.com",
      button: "Comprobar",
      note: "Gratis y sin registro. Leemos tu /llms.txt como lo haría un asistente y te mostramos cada problema con su línea y cómo arreglarlo.",
    },
    stepsH: "Siete pasos",
    steps: [
      {
        name: "Ábrelo",
        text: "Abre tuweb.com/llms.txt en el navegador. Debe verse texto, no tu portada ni una página de error.",
      },
      {
        name: "Mira la línea 1",
        text: "La línea 1 es tu nombre tras un #: `# Tu negocio`. Es lo único que exige el formato.",
      },
      {
        name: "Añade un resumen",
        text: "Debajo, una línea que empieza por >: qué haces y dónde. Es opcional, pero ayuda.",
      },
      {
        name: "Que cada enlace sea un enlace",
        text: "Bajo cada título ##, un enlace por línea: `- [Nombre](https://…): una nota breve`. Con direcciones https completas.",
      },
      {
        name: "Pasa un validador",
        text: "Escribe tu web en el validador de arriba y corrige cada línea que te señale.",
      },
      {
        name: "Mira qué dice Lighthouse",
        text: "Opcional: en Chrome, abre DevTools, luego Lighthouse, marca la categoría Agentic Browsing y ejecútalo.",
      },
      {
        name: "Vuelve a comprobar",
        text: "Sube el archivo corregido y comprueba otra vez. Una caché puede mostrar el anterior durante un rato.",
      },
    ],
    mail: {
      label: "Enviar estos pasos a quien lleva mi web",
      subject: "Nuestro llms.txt: siete comprobaciones",
      intro: "Hola:\n\n¿Puedes revisar nuestro llms.txt con estos siete pasos?",
      validator: "Escribe la web en {url} y corrige cada línea que señale.",
      outro: "La guía, con los errores comunes y cómo arreglarlos:",
    },
    errorsH: "Errores comunes y cómo arreglarlos",
    errorsCols: ["Lo que ves", "Cómo arreglarlo"],
    errors: [
      {
        problem: "Tu portada, o una página de “no encontrado”, en /llms.txt",
        fix: "Aún no hay archivo. Sube uno llamado llms.txt a la raíz de tu web, o actívalo en tu plataforma.",
      },
      {
        problem: "La línea 1 no es `# Tu nombre`",
        fix: "Pon en la línea 1 el nombre de tu negocio tras un # y un espacio. Antes solo puede haber líneas en blanco.",
      },
      {
        problem: "`- Carta: https://…`",
        fix: "Escríbelo como enlace: `- [Carta](https://…): mediodía y noche`. Lighthouse de Chrome suspende un archivo sin ningún enlace Markdown.",
      },
      {
        problem: "Títulos `###`, o un título entre tu nombre y tus secciones",
        fix: "Deja un único # para tu nombre y usa ## para cada sección.",
      },
      {
        problem: "`http://` o `/carta`",
        fix: "Usa la dirección completa con https: `https://tunegocio.com/carta`.",
      },
      { problem: "Un enlace lleva a una página que no existe", fix: "Corrige la dirección o quita la línea." },
      {
        problem: "Tu robots.txt bloquea /llms.txt",
        fix: "Permítelo: los lectores que respetan robots.txt no leen un archivo bloqueado. El [comprobador de rastreadores de IA](@tool:ai-crawlers) te muestra la línea.",
      },
      {
        problem: "Error 403 o 429, o una página de “comprobando tu navegador”",
        fix: "Tu alojamiento o tu cortafuegos frena a los lectores. Pídeles que dejen pasar /llms.txt.",
      },
      { problem: "Caracteres raros, como Ã© en lugar de é", fix: "Guarda el archivo como texto plano UTF-8." },
    ],
    sampleH: "Así se ve un archivo válido",
    sampleIntro: "Corto, con tu nombre primero y un enlace por línea:",
    sample: `# Panadería La Espiga

> Panadería y cafetería de masa madre, bollería y tartas por encargo. Abrimos todos los días desde las 7:00.

## Visítanos y encarga

- [Productos y precios](https://laespiga.example/productos): panes, bollería y café
- [Encargar una tarta](https://laespiga.example/tartas): con tres días de antelación
- [Horario y cómo llegar](https://laespiga.example/visitanos)

## Optional

- [Nuestra historia](https://laespiga.example/historia)`,
    sampleMore: "[Más ejemplos](@llms-txt-examples): restaurante, peluquería, clínica, tienda, oficios y más.",
    limitsH: "Lo que hace un archivo válido, y lo que no",
    limits: [
      "La Búsqueda de Google no usa llms.txt. Lighthouse de Chrome lo audita, y algunas herramientas de IA lo leen.",
      "Un archivo válido ayuda a un asistente a entender tu negocio. Para que pueda preguntar, reservar o pedir, necesitas una puerta: una herramienta, una API o una [bandeja para agentes](@start) que reciba la solicitud. Más en [qué hace llms.txt, y qué no](@guide:llms-txt), en inglés.",
    ],
    cover: { line: "Línea", name: "nombre", summary: "resumen", link: "enlace corregido", verdict: "llms.txt válido" },
    faqs: [
      {
        q: "¿Qué hace válido un llms.txt?",
        a: "Según llmstxt.org, solo una cosa es obligatoria: un título # con tu nombre. Un buen archivo añade un resumen con > y secciones ## con enlaces [nombre](url).",
      },
      {
        q: "¿Google revisa mi llms.txt?",
        a: "La Búsqueda de Google no lo usa. Lighthouse de Chrome (13.3 o posterior) lo revisa en Agentic Browsing: un título #, al menos 50 caracteres y un enlace Markdown.",
      },
      {
        q: "¿Necesito también un llms-full.txt?",
        a: "No. llms-full.txt es una costumbre de la comunidad, no parte de la propuesta llms.txt.",
      },
      {
        q: "¿Puedo poner el llms.txt en una carpeta?",
        a: "Sí. Desde la versión 2 de la propuesta (agosto de 2026), un archivo en una ruta como /docs/llms.txt cubre las páginas bajo esa ruta.",
      },
    ],
  },

  examples: {
    title: "Ejemplos de llms.txt para pequeños negocios · Surfing Dog",
    description:
      "Ejemplos de llms.txt para copiar: restaurante, peluquería, clínica, tienda, oficios, alojamiento y más, en el formato de llmstxt.org. Copia y comprueba.",
    h1: "Ejemplos de llms.txt para pequeños negocios",
    intro: "Elige el más parecido a tu negocio, cópialo, cambia textos y direcciones y compruébalo.",
    short: "Ejemplos de llms.txt",
    idea: "Un restaurante, una peluquería, una clínica:\nun llms.txt para cada uno, listo para copiar.",
    coverAlt:
      "Fichas de un restaurante, una peluquería, un oficio y una tienda se iluminan por turnos, y a su lado un llms.txt se reescribe para cada uno: su nombre, su primera sección y su primer enlace.",
    made: "Todos los nombres y direcciones son inventados. Las direcciones que terminan en .example no pueden ser de nadie.",
    jump: "Ejemplos",
    kinds: [
      {
        id: "restaurant",
        label: "Restaurante",
        name: "Restaurante, cafetería o bar",
        note: "La carta, el horario, las reservas y las condiciones por las que preguntan los clientes.",
        file: `# Casa Lucía

> Restaurante de cocina de mercado y vinos naturales. Abrimos de martes a domingo, a mediodía y por la noche.

Para grupos pequeños no hace falta reservar; a partir de cinco personas, reserva. Los precios incluyen impuestos. Platos vegetarianos y sin gluten cada día; avísanos de cualquier alergia al reservar.

## Visítanos y reserva

- [Carta y precios](https://casalucia.example/carta): menú de mediodía y carta de noche, cambia cada semana
- [Horario y cómo llegar](https://casalucia.example/visitanos): dirección, mapa y transporte público
- [Reservar mesa](https://reservas.casalucia.example/): en línea, hasta 8 personas
- [Eventos privados](https://casalucia.example/eventos): grupos de 10 a 40, presupuesto a petición

## Condiciones

- [Cancelaciones y anticipo](https://casalucia.example/condiciones): cancelación gratis hasta 24 horas antes
- [Alérgenos](https://casalucia.example/alergenos): plato por plato

## Para agentes de IA

- [Bandeja para agentes](https://bandeja.casalucia.example/.well-known/agent-inbox.json): mensajes, presupuestos y reservas de mesa
- [Servidor MCP](https://bandeja.casalucia.example/mcp): ver disponibilidad y pedir reserva

## Optional

- [Nuestra historia](https://casalucia.example/historia)`,
      },
      {
        id: "salon",
        label: "Peluquería",
        name: "Peluquería, estética o barbería",
        note: "Servicios con precio, la página de reservas que ya usas y la regla de cancelación.",
        file: `# Peluquería Alma

> Peluquería y estética: cortes, color, peinados, uñas y cejas. Abrimos de martes a sábado; los jueves, hasta tarde.

Mejor con cita; sin cita si hay un sillón libre. Atendemos en español, inglés y portugués.

## Servicios y citas

- [Servicios y precios](https://peluqueriaalma.example/servicios): desde un retoque de flequillo hasta color completo
- [Pedir cita](https://citas.peluqueriaalma.example/): elige estilista y hora
- [El equipo](https://peluqueriaalma.example/equipo): quién hace qué

## Condiciones

- [Cancelaciones](https://peluqueriaalma.example/cancelaciones): gratis hasta 24 horas antes; después se cobra la mitad
- [Tarjetas regalo](https://peluqueriaalma.example/regalo): cualquier importe, válidas 12 meses

## Para agentes de IA

- [Bandeja para agentes](https://bandeja.peluqueriaalma.example/.well-known/agent-inbox.json): preguntas y solicitudes de cita

## Optional

- [Consejos para tu pelo](https://peluqueriaalma.example/blog)`,
      },
      {
        id: "clinic",
        label: "Clínica",
        name: "Clínica: dentista, fisioterapia, veterinaria o terapia",
        note: "Tratamientos, tarifas y cómo pedir cita; nunca nada sobre pacientes. Sin puerta todavía, así que sin sección para agentes.",
        file: `# Clínica Dental Ceiba

> Clínica dental familiar: revisiones, limpiezas, empastes, blanqueamiento y odontopediatría. Abrimos de lunes a sábado.

Pacientes nuevos bienvenidos. Si tienes mucho dolor o inflamación, llámanos antes de venir.

## Tratamientos y citas

- [Tratamientos y tarifas](https://clinicaceiba.example/tratamientos): rangos de precio por tratamiento
- [Pedir cita](https://clinicaceiba.example/cita): revisiones y limpiezas en línea; lo demás, tras una revisión
- [Tu primera visita](https://clinicaceiba.example/primera-visita): qué traer y cuánto dura
- [Seguros y planes de pago](https://clinicaceiba.example/seguros): con quién trabajamos

## Condiciones

- [Cancelaciones](https://clinicaceiba.example/cancelaciones): avísanos con 24 horas
- [Urgencias](https://clinicaceiba.example/contacto): atención el mismo día por dolor o accidentes

## Optional

- [Nuestros dentistas](https://clinicaceiba.example/equipo)`,
      },
      {
        id: "shop",
        label: "Tienda",
        name: "Tienda en línea o de barrio",
        note: "Colecciones, envíos y devoluciones, y los perfiles de compra que muchas plataformas publican por ti.",
        file: `# Tostadores Cumbre

> Café de especialidad tostado cada semana, en grano o molido, y todo para prepararlo. Enviamos a muchos países.

Envío gratis a partir de cierto importe, que verás al pagar. Los pedidos antes de las 14:00 salen el mismo día laborable.

## Tienda

- [Cafés](https://tostadorescumbre.example/cafes): origen, tueste y notas de cata
- [Cafeteras y molinillos](https://tostadorescumbre.example/equipo)
- [Suscripción](https://tostadorescumbre.example/suscripcion): cada 2 o 4 semanas

## Pedidos y condiciones

- [Envíos](https://tostadorescumbre.example/envios): plazos y costes por país
- [Devoluciones](https://tostadorescumbre.example/devoluciones): 30 días, sin abrir
- [Seguir un pedido](https://tostadorescumbre.example/seguimiento)
- [Formas de pago](https://tostadorescumbre.example/pago): tarjeta, carteras digitales y transferencia

## Para agentes de IA

- [Perfil de tienda (UCP)](https://tostadorescumbre.example/.well-known/ucp): catálogo y compra
- [Servidor MCP](https://tostadorescumbre.example/api/mcp): buscar productos y armar el carrito

## Optional

- [Guías de preparación](https://tostadorescumbre.example/blog)`,
      },
      {
        id: "trades",
        label: "Oficios",
        name: "Oficios: fontanería o plomería, electricidad, reformas o limpieza",
        note: "Dónde trabajas, cuánto cuesta una visita y cómo pedir presupuesto o una urgencia.",
        file: `# Ortiz Instalaciones

> Fontanería, gas y calentadores para casas y pequeños negocios, en la ciudad y los pueblos cercanos.

Precio fijo por desplazamiento y presupuesto antes de empezar. Urgencias todos los días, de 7:00 a 22:00.

## Servicios y presupuestos

- [Servicios y zonas](https://ortizinstalaciones.example/servicios): reparaciones, instalaciones y mantenimiento
- [Precios y desplazamiento](https://ortizinstalaciones.example/precios)
- [Pedir presupuesto](https://ortizinstalaciones.example/presupuesto): con fotos te damos un precio más fino
- [Urgencias](https://ortizinstalaciones.example/urgencias): horario y cómo avisarnos

## Condiciones

- [Certificados y seguro](https://ortizinstalaciones.example/certificados)
- [Garantía](https://ortizinstalaciones.example/garantia): 12 meses en piezas y mano de obra

## Para agentes de IA

- [Bandeja para agentes](https://bandeja.ortizinstalaciones.example/.well-known/agent-inbox.json): presupuestos y mensajes

## Optional

- [Trabajos recientes](https://ortizinstalaciones.example/trabajos)`,
      },
      {
        id: "stay",
        label: "Alojamiento",
        name: "Hotel, hostal o alojamiento rural",
        note: "Habitaciones y tarifas, reservas, horarios de llegada y las normas por las que preguntan los huéspedes.",
        file: `# Posada del Cerro

> Posada de ocho habitaciones en la montaña, con desayuno incluido y senderos desde la puerta.

Entrada desde las 15:00, salida hasta las 11:00. Admitimos perros en dos habitaciones.

## Habitaciones y reservas

- [Habitaciones y tarifas](https://posadadelcerro.example/habitaciones): con fotos y qué incluye cada una
- [Reservar](https://posadadelcerro.example/reservar): disponibilidad en tiempo real
- [Cómo llegar](https://posadadelcerro.example/como-llegar): en coche, autobús o traslado

## Condiciones

- [Cancelaciones](https://posadadelcerro.example/cancelaciones): gratis hasta 7 días antes de la llegada
- [Mascotas](https://posadadelcerro.example/mascotas)

## Para agentes de IA

- [Bandeja para agentes](https://bandeja.posadadelcerro.example/.well-known/agent-inbox.json): preguntas, grupos y solicitudes de reserva

## Optional

- [Rutas cercanas](https://posadadelcerro.example/rutas)`,
      },
      {
        id: "classes",
        label: "Clases",
        name: "Clases: gimnasio, yoga, baile o música",
        note: "El horario, los planes y la primera visita. Sin puerta todavía, así que sin sección para agentes.",
        file: `# Kalma Yoga

> Estudio de yoga y pilates con clases para todos los niveles, por la mañana y por la tarde, los siete días.

La primera clase es gratis. Te prestamos el material.

## Clases y planes

- [Horario](https://kalmayoga.example/horario): todas las clases de la semana
- [Planes y precios](https://kalmayoga.example/precios)
- [Reservar una clase](https://kalmayoga.example/reservar)
- [Tu primera visita](https://kalmayoga.example/primera-visita): qué ponerte y cuándo llegar

## Condiciones

- [Cancelaciones](https://kalmayoga.example/cancelaciones): hasta 4 horas antes de la clase

## Optional

- [Formación de profesores](https://kalmayoga.example/formacion)`,
      },
      {
        id: "professional",
        label: "Profesionales",
        name: "Servicios profesionales: asesoría, abogados, agencia o consultoría",
        note: "Qué haces, para quién, cuánto cuesta y cómo empezar.",
        file: `# Asesoría Rivas & Chen

> Contabilidad, impuestos y nóminas para profesionales independientes y pequeñas empresas.

Atendemos en español, inglés y mandarín. Cuotas mensuales fijas; la primera llamada de 20 minutos es gratis.

## Servicios

- [Servicios y tarifas](https://rivaschen.example/servicios): planes mensuales y trabajos puntuales
- [Reservar una primera llamada](https://rivaschen.example/cita)
- [Qué preparar](https://rivaschen.example/documentos): lo que necesitamos en la primera reunión

## Condiciones

- [Condiciones del servicio](https://rivaschen.example/condiciones)
- [Privacidad](https://rivaschen.example/privacidad)

## Para agentes de IA

- [Bandeja para agentes](https://bandeja.rivaschen.example/.well-known/agent-inbox.json): preguntas y solicitudes de presupuesto

## Optional

- [Calendario fiscal del año](https://rivaschen.example/calendario)`,
      },
      {
        id: "template",
        label: "Plantilla",
        name: "Una plantilla en blanco",
        note: "Cambia cada {parte entre llaves} y borra las líneas que no necesites.",
        file: `# {Nombre de tu negocio}

> {Qué haces y dónde, en una línea.}

{Opcional: horario, zonas donde trabajas, idiomas que hablas, formas de pago.}

## {Servicios | Tienda | Visítanos y reserva}

- [{Servicios y precios}](https://{tudominio}/{pagina}): {una nota breve}
- [{Horario y cómo llegar}](https://{tudominio}/{pagina})
- [{Reservar o pedir}](https://{tu dirección de reservas o tienda})

## Condiciones

- [{Cancelaciones, envíos o devoluciones}](https://{tudominio}/{pagina})

## Para agentes de IA

- [{Bandeja para agentes, servidor MCP o perfil de tienda}](https://{su dirección}): {qué recibe}

## Optional

- [{Quiénes somos}](https://{tudominio}/{pagina})`,
      },
    ],
    howH: "Cómo usar un ejemplo",
    how: [
      "Copia el ejemplo más parecido y cambia el nombre, el resumen y cada dirección.",
      "Deja solo lo que sea cierto para ti, y enlaza páginas que ya existan.",
      "Súbelo como llms.txt a la raíz de tu web, para que se abra en tuweb.com/llms.txt.",
      "Compruébalo con el [validador de llms.txt](@tool:llms-txt) y corrige cada línea que te señale.",
    ],
    generator:
      "O empieza desde tu propia web: el [generador de llms.txt](@tool:llms-txt-generator) escribe una primera versión con lo que tu web ya dice.",
    doorsH: "La sección “Para agentes de IA”",
    doors: [
      "Pon solo puertas que funcionen hoy: una bandeja para agentes, un servidor MCP, el perfil de compra de una tienda. ¿Aún no tienes ninguna? Quita la sección. Una [bandeja para agentes](@start) te da una.",
      "## Optional es el nombre que el formato da, por convención, a los enlaces que se pueden saltar, así que se queda en inglés en todos los idiomas.",
    ],
    faqs: [
      {
        q: "¿Qué pone un pequeño negocio en su llms.txt?",
        a: "Tu nombre como título #, una frase sobre qué haces y dónde, y enlaces a las páginas que responden a tus clientes: servicios y precios, horario y ubicación, reservas, condiciones. Añade tus puertas para agentes si las tienes.",
      },
      {
        q: "¿En qué idioma lo escribo?",
        a: "En el de tus clientes, el mismo de tu web. Los asistentes leen muchos idiomas.",
      },
      {
        q: "¿Puedo enlazar mi plataforma de reservas o WhatsApp?",
        a: "Sí, como enlaces con una nota: - [Reservar mesa](https://…): hasta 8 personas. Solo direcciones públicas; nunca enlaces privados ni contactos del personal.",
      },
      {
        q: "¿Dónde lo subo en Wix, Shopify o WordPress?",
        a: "Wix puede crearlo por ti; en WordPress, Yoast y AIOSEO; muchas tiendas Shopify ya sirven uno. En otras webs, sube un archivo llamado llms.txt a la raíz.",
      },
    ],
  },

  payments: {
    title: "Pagos agénticos y pagos asistidos por IA: qué son",
    description:
      "Un asistente de IA llena el carrito o reserva y la persona aprueba el pago. Cómo funciona y sus estándares (tarjetas, carteras, UCP, ACP, AP2, x402).",
    h1: "Pagos asistidos por agentes de IA: qué son y cómo funcionan",
    intro:
      "Un pago que un asistente de IA inicia o completa para una persona, que sigue aprobándolo. Así funciona hoy, y esto puede hacer un pequeño negocio.",
    short: "Pagos asistidos por IA",
    idea: "El asistente llena el carrito.\nLa persona aprueba. Tú cobras.",
    coverAlt:
      "El asistente de un cliente llena un carrito y le pide a la persona que apruebe. La persona aprueba en su teléfono, un token limitado viaja hasta el negocio y el negocio cobra.",
    answer:
      "Es un pago que un asistente de IA prepara para una persona, que lo sigue aprobando con un toque, una llave de acceso o la app de su banco. El negocio cobra por su proveedor de siempre y el asistente nunca necesita el número de la tarjeta.",
    kindsH: "¿Asistido o agéntico?",
    kinds: [
      {
        name: "Asistido por un agente",
        says: "El asistente busca, llena el carrito o reserva. La persona aprueba el pago, cada vez.",
      },
      {
        name: "Agéntico",
        says: "El agente paga solo, dentro de límites que la persona fijó antes: una tienda, un importe, una fecha.",
      },
    ],
    kindsSource:
      "La consultora Forrester trazó esta línea en [noviembre de 2025](https://www.forrester.com/blogs/the-race-to-agentic-payments-in-us-b2c-e-commerce-where-we-are-now/), en inglés.",
    stepsH: "Cómo funciona",
    steps: [
      "El asistente encuentra lo que quiere la persona, con su precio: una mesa, un corte de pelo, un producto.",
      "Llena el carrito o aparta la reserva, y le pide a la persona que apruebe.",
      "La persona aprueba con un toque, una llave de acceso o la app de su banco. Esa aprobación se convierte en un token o un mandato, limitado a un negocio, un importe o un plazo.",
      "Tu pasarela o tu proveedor de pagos comprueba el token y cobras como siempre. El asistente nunca ve el número de una tarjeta.",
    ],
    standardsH: "Los estándares de los que oirás hablar",
    standardsCols: ["Nombre", "Qué es"],
    standards: [
      {
        name: "Tokens de las redes de tarjetas",
        what: "Visa Intelligent Commerce y Mastercard Agent Pay: tokens que las redes de tarjetas emiten para agentes, a través de tu proveedor de pagos.",
      },
      {
        name: "Carteras digitales y apps del banco",
        what: "Donde la persona aprueba, con una llave de acceso o su huella, un pago que preparó un asistente.",
      },
      {
        name: "Mandatos bancarios",
        what: "Pagos de cuenta a cuenta con límites fijados una vez, como Pix Automático, UPI AutoPay, PayTo o el adeudo directo SEPA. Si un agente puede usar uno depende del sistema y de tu banco.",
      },
      {
        name: "UCP",
        what: "Universal Commerce Protocol: el perfil de compra de una tienda para agentes. Sus gestores de pago dicen cómo puede pagar un agente.",
        href: "https://ucp.dev",
      },
      {
        name: "ACP",
        what: "Agentic Commerce Protocol: compra para agentes, con pago delegado a través del proveedor de la propia tienda.",
        href: "https://www.agenticcommerce.dev",
      },
      {
        name: "AP2",
        what: "Agent Payments Protocol: mandatos que firma una persona para que un agente pague dentro de unos límites.",
        href: "https://ap2-protocol.org",
      },
      {
        name: "x402",
        what: "Pagos por HTTP, sobre todo en stablecoins. Hoy encaja más con software y APIs que con una peluquería o una tienda.",
        href: "https://www.x402.org",
      },
    ],
    standardsNote: "Esto cambia de un mes a otro. Escrito en octubre de 2026; pregunta a tu proveedor antes de elegir.",
    doH: "Qué puede hacer hoy un pequeño negocio",
    do: [
      "Di en tu web cómo cobras: al momento, con anticipo, al llegar o con factura. Un asistente lo lee antes de comprometerse en nombre de la persona.",
      "Envía un enlace de pago a tu propia pasarela. Funciona hoy con cualquier asistente: el agente hace el resto y paga una persona.",
      "Pregunta a tu proveedor de pagos qué tokens para agentes y qué carteras acepta, y en qué países.",
      "Si vendes en línea, pregunta a tu plataforma si publica un perfil de compra (UCP o ACP) para tu tienda. El [comprobador UCP y ACP](@tool:ucp) te muestra qué hay.",
    ],
    counts: {
      h: "En nuestro directorio",
      line: "De los {checked} sitios web de negocios que hemos revisado, {pay} cobran a través de una puerta que un agente puede usar. Recuento del {date}.",
      link: "Verlos en las clasificaciones",
      wait: "Aquí aparecen los recuentos en vivo de nuestro directorio.",
      none: "Los recuentos no están disponibles ahora mismo.",
    },
    next: "comprueba si un asistente encuentra cómo pagarte.",
    cover: {
      assistant: "Su asistente",
      person: "La persona",
      business: "Tu negocio",
      approve: "¿Aprobar?",
      token: "Una tienda · un importe",
      paid: "Cobrado",
    },
    faqs: [
      {
        q: "¿Qué diferencia hay entre pago asistido y pago agéntico?",
        a: "En el asistido, la persona lo aprueba, por ejemplo con un toque o una llave de acceso. En el agéntico, el agente paga solo dentro de límites fijados antes. Forrester trazó esta línea en noviembre de 2025.",
      },
      {
        q: "¿Puede ChatGPT u otro asistente pagar?",
        a: "Algunos asistentes llenan un carrito o inician un pago, y algunas redes de pago dejan que un agente pague con un token que la persona aprobó. Lo disponible cambia según asistente, país y proveedor.",
      },
      {
        q: "¿Es seguro que un agente pague a mi negocio?",
        a: "El agente no necesita el número de tarjeta: tokens, carteras y mandatos se limitan a un comercio, un importe o un plazo, y la persona los aprueba. Cobras por tu proveedor de siempre.",
      },
      {
        q: "¿Necesito otro software para aceptarlo?",
        a: "Para empezar, normalmente no: un enlace de pago en tu propia web funciona con cualquier asistente. Los tokens para agentes y las carteras llegan por tu proveedor de pagos; pregúntale cuáles admite.",
      },
    ],
  },
};
