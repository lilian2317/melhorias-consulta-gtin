export default async function handler(req, res) {
  try {
    const qRaw = (req.query.q ?? "").toString().trim();       // busca geral
    const gtinRaw = (req.query.gtin ?? "").toString().trim(); // opcional
    const nameRaw = (req.query.name ?? "").toString().trim(); // opcional

    const notionToken = process.env.NOTION_TOKEN;
    const dbId = process.env.NOTION_DB_ID;

    const digitsOnly = (s) => String(s || "").replace(/\D/g, "");
    const collapseSpaces = (s) => String(s || "").replace(/\s+/g, " ").trim();

    const normalizeForTokens = (s) => {
      return collapseSpaces(String(s || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, " ")
      );
    };

    const STOP = new Set([
      "de","da","do","das","dos","para","por","com","e","a","o","as","os",
      "um","uma","no","na","nos","nas","em","ao","aos","à","às"
    ]);

    const tokenize = (s) => {
      const norm = normalizeForTokens(s);
      const parts = norm.split(" ").map(t => t.trim()).filter(Boolean);
      const tokens = [];
      for (const t of parts) {
        if (STOP.has(t)) continue;
        if (t.length < 2) continue;
        tokens.push(t);
      }
      return [...new Set(tokens)];
    };

    // Decide as consultas finais
    let gtinQuery = digitsOnly(gtinRaw);
    let nameQuery = collapseSpaces(nameRaw);

    if (!gtinQuery && !nameQuery && qRaw) {
      const qDigits = digitsOnly(qRaw);
      const qNoSpaces = qRaw.replace(/\s/g, "");
      if (qDigits && qDigits.length >= 4 && qDigits.length === qNoSpaces.length) {
        // Se digitou basicamente números (ex.: 222490), trata como GTIN parcial
        gtinQuery = qDigits;
      } else {
        nameQuery = collapseSpaces(qRaw);
      }
    }

    if (!gtinQuery && !nameQuery) {
      return res.status(400).json({ error: "Informe GTIN ou Nome" });
    }

    // Monta filtros
    const orFilters = [];

    // 1) GTIN: suporta busca parcial (contains) e também exata (equals)
    if (gtinQuery) {
      orFilters.push({
        property: "GTIN",
        rich_text: { equals: gtinQuery },
      });
      orFilters.push({
        property: "GTIN",
        rich_text: { contains: gtinQuery },
      });
    }

    // 2) Nome: frase, variação sem espaços e busca por tokens (AND)
    if (nameQuery) {
      const nameNoSpaces = nameQuery.replace(/\s+/g, "");
      orFilters.push({
        property: "Nome dos Produtos",
        title: { contains: nameQuery },
      });

      if (nameNoSpaces && nameNoSpaces !== nameQuery) {
        orFilters.push({
          property: "Nome dos Produtos",
          title: { contains: nameNoSpaces },
        });
      }

      const tokens = tokenize(nameQuery).slice(0, 6);
      if (tokens.length >= 2) {
        orFilters.push({
          and: tokens.map(t => ({
            property: "Nome dos Produtos",
            title: { contains: t },
          })),
        });

        // Variante simples: singulariza tokens que terminam com "s"
        const singularTokens = tokens.map(t => (t.length > 3 && t.endsWith("s")) ? t.slice(0, -1) : t);
        const changed = singularTokens.some((t, i) => t !== tokens[i]);
        if (changed) {
          orFilters.push({
            and: singularTokens.map(t => ({
              property: "Nome dos Produtos",
              title: { contains: t },
            })),
          });
        }
      } else if (tokens.length === 1) {
        orFilters.push({
          property: "Nome dos Produtos",
          title: { contains: tokens[0] },
        });
      }
    }

    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${notionToken}`,
        "Content-Type": "application/json",
        "Notion-Version": "2022-06-28",
      },
      body: JSON.stringify({
        filter: orFilters.length === 1 ? orFilters[0] : { or: orFilters },
        page_size: 100, // ✅ até 100 resultados (máximo do Notion)
      }),
    });

    const data = await r.json();
    if (!r.ok) return res.status(500).json({ error: "Erro Notion", details: data });

    const results = data.results ?? [];
    if (!results.length) return res.status(404).json({ found: false, items: [] });

    const items = results.map((page) => {
      const props = page.properties;

      const nameOut =
        props["Nome dos Produtos"]?.title?.map(t => t.plain_text).join("") || "Sem nome";

      const preco =
        props["Domingas R$"]?.number ??
        props["Domingas R$"]?.rich_text?.map(t => t.plain_text).join("") ??
        null;

      const img =
        props["IMAGEM"]?.files?.[0]?.file?.url ??
        props["IMAGEM"]?.files?.[0]?.external?.url ??
        null;

      const gtinOut =
        props["GTIN"]?.rich_text?.map(t => t.plain_text).join("") || null;

      return { name: nameOut, preco, img, gtin: gtinOut };
    });

    res.json({ found: true, items });
  } catch (e) {
    res.status(500).json({ error: "Erro interno", details: String(e) });
  }
}
