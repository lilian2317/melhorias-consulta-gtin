// API: /api/lookup
// Melhorias para uso por idosas:
// - GTIN parcial (ex.: digitar só o final)
// - Busca por nome tolerante (espaços, 'de', plural simples) + comparação sem espaços
// - Retorna até 100 itens

export default async function handler(req, res) {
  try {
    const qRaw = (req.query.q ?? "").toString();
    const q = qRaw.trim();

    const notionToken = process.env.NOTION_TOKEN;
    const dbId = process.env.NOTION_DB_ID;

    if (!notionToken || !dbId) {
      return res.status(500).json({ error: "Variáveis NOTION_TOKEN / NOTION_DB_ID não configuradas" });
    }

    if (!q) {
      return res.status(400).json({ error: "Informe um termo de busca" });
    }

    const isDigits = /^\d+$/.test(q);
    const gtinQuery = isDigits ? q : "";

    const normalize = (s) =>
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const STOP = new Set(["de","da","do","das","dos","para","pra","com","sem","um","uma","uns","umas","e","a","o","as","os","no","na","nos","nas","ao","aos"]);

    const makeTokens = (s) => {
      const base = normalize(s);
      return base
        .split(" ")
        .map(t => t.trim())
        .filter(Boolean)
        .map(t => (t.length > 3 && t.endsWith("s") ? t.slice(0, -1) : t)) // plural simples
        .filter(t => !STOP.has(t));
    };

    const nameTokens = isDigits ? [] : makeTokens(q).slice(0, 8); // limita p/ não estourar filtros

    // Filtro inicial (para reduzir universo). Depois fazemos um ranqueamento local.
    let filter = null;

    if (gtinQuery) {
      // GTIN parcial
      filter = {
        property: "GTIN",
        rich_text: { contains: gtinQuery }
      };
    } else if (nameTokens.length) {
      // OR com tokens (broad match); refinamos localmente
      filter = {
        or: nameTokens.map(t => ({
          property: "NOME",
          title: { contains: t }
        }))
      };
    } else {
      // fallback muito raro (ex.: só stopwords): tenta pelo texto bruto
      filter = {
        property: "NOME",
        title: { contains: q }
      };
    }

    const notionRes = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        page_size: 100,
        filter,
      }),
    });

    const data = await notionRes.json().catch(() => ({}));

    if (!notionRes.ok) {
      return res.status(notionRes.status).json({ error: "Erro ao consultar Notion", details: data });
    }

    const results = Array.isArray(data.results) ? data.results : [];

    const items = results.map((p) => {
      const props = p.properties || {};

      const nameOut =
        props["NOME"]?.title?.map(t => t.plain_text).join("") || "Sem nome";

      const preco =
        props["PREÇO"]?.number ??
        props["PRECO"]?.number ??
        null;

      const img =
        props["IMAGEM"]?.files?.[0]?.file?.url ??
        props["IMAGEM"]?.files?.[0]?.external?.url ??
        null;

      const gtinOut =
        props["GTIN"]?.rich_text?.map(t => t.plain_text).join("") || null;

      return { name: nameOut, preco, img, gtin: gtinOut };
    });

    // Ranqueamento local para “tolerância” (ex.: "tododia" vs "todo dia")
    const qNorm = normalize(q);
    const qNormNoSpace = qNorm.replace(/\s+/g, "");
    const tokens = makeTokens(q);

    const scored = items.map((it) => {
      const nameNorm = normalize(it.name);
      const nameNoSpace = nameNorm.replace(/\s+/g, "");
      const gtin = (it.gtin || "").replace(/\D/g, "");

      let score = 0;

      if (gtinQuery && gtin.includes(gtinQuery)) score += 200;

      // comparação sem espaços (resolve tododia vs todo dia)
      if (!gtinQuery && qNormNoSpace && nameNoSpace.includes(qNormNoSpace)) score += 80;

      // bônus por tokens
      if (!gtinQuery && tokens.length) {
        let hits = 0;
        for (const t of tokens) {
          if (nameNorm.includes(t)) hits++;
        }
        score += hits * 12;

        // se acertar quase tudo, bônus extra
        if (hits >= Math.max(2, Math.floor(tokens.length * 0.75))) score += 40;
      }

      return { it, score };
    }).sort((a,b)=>b.score-a.score);

    const finalItems = scored
      .filter(x => x.score > 0)
      .slice(0, 100)
      .map(x => x.it);

    if (!finalItems.length) {
      return res.json({ found: false, items: [] });
    }

    res.json({ found: true, items: finalItems });
  } catch (e) {
    res.status(500).json({ error: "Erro interno", details: String(e) });
  }
}
