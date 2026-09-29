/**
 * Dojo Quiz — relais serveur (Cloudflare Worker)
 *
 * Rôle : recevoir les photos de la leçon envoyées par l'application,
 * appeler l'API Claude (Anthropic) avec la clé secrète, et renvoyer un QCM
 * au format JSON. La clé API ne quitte jamais ce serveur.
 *
 * Variables à définir dans Cloudflare (Settings > Variables and Secrets) :
 *   ANTHROPIC_API_KEY  (secret)  clé API Anthropic
 *   ACCESS_CODE        (secret)  code familial saisi dans l'appli (anti-abus)
 *   ALLOWED_ORIGIN     (texte)   ex. https://monpseudo.github.io   (ou * pour tester)
 *   MODEL              (texte, optionnel) défaut : claude-sonnet-5-5
 */

const DEFAULT_MODEL = "claude-sonnet-5-5";
const MAX_IMAGES = 4;
const MAX_IMAGE_BASE64 = 6_000_000; // ~4,5 Mo par image après compression côté appli

// Matières du programme de 6e (cycle 3), détectées par le modèle
const SUBJECT_IDS = ["francais", "maths", "histoire", "sciences", "langues", "autre"];

const SYSTEM_PROMPT = `Tu es un professeur de collège bienveillant et exigeant. Tu crées des QCM pour vérifier qu'un élève de 6e a bien COMPRIS sa leçon.

Règles impératives :
- Base-toi UNIQUEMENT sur le contenu visible sur les photos (manuel ou cahier, parfois manuscrit). N'invente aucune notion absente de la leçon.
- Si les photos sont illisibles, hors sujet (pas une leçon), ou trop pauvres pour poser des questions, mets readable à false et explique le problème en une phrase simple adressée à l'enfant.
- Langue : français correct, phrases courtes, vocabulaire d'un élève de 11 ans. Pour l'anglais, les questions peuvent contenir de l'anglais mais les consignes restent en français.
- Mélange les types : environ 1/3 "memorisation" (définitions, dates, règles, vocabulaire) et 2/3 "comprehension" (appliquer la règle à un nouvel exemple, reconnaître un cas, expliquer pourquoi, petit calcul, repérer une erreur).
- Exactement 4 choix par question, une seule bonne réponse sans ambiguïté. Les mauvaises réponses doivent être plausibles (erreurs typiques d'élève), jamais absurdes ni piégeuses sur un détail de formulation.
- Varie la position de la bonne réponse.
- Pas de "toutes les réponses" / "aucune de ces réponses".
- L'explication (1 à 2 phrases) dit pourquoi la bonne réponse est juste, en s'appuyant sur la leçon, sur un ton encourageant.
- Les questions suivent l'ordre de la leçon.
- Identifie la matière d'après le contenu : francais, maths, histoire (histoire, géographie ou EMC), sciences (sciences et technologie : vivant, matière, énergie, objets techniques), langues (anglais ou autre langue vivante), autre (si aucune ne convient).
- En maths, écris les nombres et opérations en texte simple (ex. 3/4, 2,5 × 4), sans LaTeX.`;

const QUIZ_TOOL = {
  name: "creer_qcm",
  description: "Enregistre le QCM construit à partir des photos de la leçon.",
  input_schema: {
    type: "object",
    properties: {
      readable: { type: "boolean", description: "false si les photos ne permettent pas de faire un QCM" },
      problem: { type: "string", description: "Si readable=false : explication courte pour l'enfant (ex. photo floue)." },
      subject: { type: "string", enum: SUBJECT_IDS, description: "Matière détectée" },
      title: { type: "string", description: "Titre court de la leçon, tel qu'il apparaît ou résumé en 3 à 6 mots" },
      summary: { type: "string", description: "Résumé de la leçon en 2 phrases, pour l'enfant" },
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: {
            question: { type: "string" },
            choices: { type: "array", items: { type: "string" }, minItems: 4, maxItems: 4 },
            answer_index: { type: "integer", minimum: 0, maximum: 3 },
            explanation: { type: "string" },
            kind: { type: "string", enum: ["memorisation", "comprehension"] },
          },
          required: ["question", "choices", "answer_index", "explanation", "kind"],
        },
      },
    },
    required: ["readable"],
  },
};

function corsHeaders(env, request) {
  const allowed = env.ALLOWED_ORIGIN || "*";
  const origin = request.headers.get("Origin") || "";
  const allowOrigin = allowed === "*" ? "*" : (origin === allowed ? origin : allowed);
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Access-Code",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ error: "Méthode non autorisée." }, 405, cors);

    // Code d'accès familial : évite que n'importe qui utilise votre crédit API.
    if (!env.ACCESS_CODE || request.headers.get("X-Access-Code") !== env.ACCESS_CODE) {
      return json({ error: "Code d'accès incorrect. Demande à tes parents de le vérifier dans les réglages." }, 401, cors);
    }
    if (!env.ANTHROPIC_API_KEY) return json({ error: "Clé API absente côté serveur." }, 500, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Requête invalide." }, 400, cors); }

    const images = Array.isArray(body.images) ? body.images.slice(0, MAX_IMAGES) : [];
    if (images.length === 0) return json({ error: "Aucune photo reçue." }, 400, cors);
    for (const img of images) {
      if (!img || typeof img.data !== "string" || !/^image\/(jpeg|png|webp)$/.test(img.media_type || "")) {
        return json({ error: "Format de photo non pris en charge." }, 400, cors);
      }
      if (img.data.length > MAX_IMAGE_BASE64) return json({ error: "Photo trop lourde." }, 413, cors);
    }

    const count = Math.min(Math.max(parseInt(body.count, 10) || 8, 4), 12);

    const content = images.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    }));
    content.push({
      type: "text",
      text: `Niveau : 6e.\nVoici ${images.length} photo(s) de la leçon, dans l'ordre.\nCrée exactement ${count} questions (moins seulement si la leçon est vraiment trop courte, minimum 4) et appelle l'outil creer_qcm.`,
    });

    let apiRes;
    try {
      apiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: env.MODEL || DEFAULT_MODEL,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          tools: [QUIZ_TOOL],
          tool_choice: { type: "tool", name: "creer_qcm" },
          messages: [{ role: "user", content }],
        }),
      });
    } catch (e) {
      return json({ error: "Impossible de joindre le service d'IA. Réessaie dans un instant." }, 502, cors);
    }

    if (!apiRes.ok) {
      const detail = await apiRes.text();
      console.log("Anthropic error", apiRes.status, detail);
      const msg = apiRes.status === 429 || apiRes.status === 529
        ? "Le service est très demandé. Réessaie dans une minute."
        : "Le service d'IA a renvoyé une erreur (" + apiRes.status + ").";
      return json({ error: msg }, 502, cors);
    }

    const data = await apiRes.json();
    const tool = (data.content || []).find((b) => b.type === "tool_use" && b.name === "creer_qcm");
    if (!tool) return json({ error: "Réponse inattendue du service d'IA." }, 502, cors);

    const quiz = tool.input || {};
    if (quiz.readable === false) {
      return json({ readable: false, problem: quiz.problem || "Je n'arrive pas à lire la leçon. Reprends la photo bien à plat, avec de la lumière." }, 200, cors);
    }

    // Contrôle de cohérence : on écarte toute question mal formée.
    const questions = (quiz.questions || []).filter((q) =>
      q && typeof q.question === "string" && Array.isArray(q.choices) && q.choices.length === 4 &&
      Number.isInteger(q.answer_index) && q.answer_index >= 0 && q.answer_index <= 3
    );
    if (questions.length < 3) {
      return json({ readable: false, problem: "La leçon est trop courte ou peu lisible pour faire un QCM. Ajoute une autre photo." }, 200, cors);
    }

    return json({
      readable: true,
      subject: SUBJECT_IDS.includes(quiz.subject) ? quiz.subject : "autre",
      title: quiz.title || "Ma leçon",
      summary: quiz.summary || "",
      questions,
      usage: data.usage || null,
    }, 200, cors);
  },
};
