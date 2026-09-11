// Worker para El Recreo — sin dependencias externas (se pega directo en el panel de Cloudflare)
//
// CONFIGURACIÓN NECESARIA (en el panel de Cloudflare, dentro de este Worker):
// Settings → Variables and Secrets → Add
//   Nombre: DATABASE_URL
//   Valor: tu cadena de conexión de Neon (la que empieza por postgresql://...)
//   Tipo: Secret (marca la opción de "encriptar")

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders },
  });
}

// Ejecuta una consulta SQL contra Neon usando su API HTTP, sin ninguna librería.
async function query(env, sql, params = []) {
  const host = new URL(env.DATABASE_URL.replace('postgresql://', 'https://')).host;
  const res = await fetch(`https://${host}/sql`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Neon-Connection-String': env.DATABASE_URL,
    },
    body: JSON.stringify({ query: sql, params }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Error de base de datos (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.rows || [];
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /api/menu — categorías con sus productos
      if (path === '/api/menu' && request.method === 'GET') {
        const categories = await query(env, 'SELECT id, slug, name, sort_order FROM categories ORDER BY sort_order');
        const products = await query(env, 'SELECT id, category_id, name, format_note, price, is_popular, allergens, sort_order FROM products ORDER BY sort_order');
        const menu = categories.map(c => ({
          ...c,
          items: products.filter(p => p.category_id === c.id),
        }));
        return json(menu);
      }

      // PATCH /api/products/:id — cambiar el precio de un producto
      if (path.startsWith('/api/products/') && request.method === 'PATCH') {
        const id = path.split('/').pop();
        const body = await request.json();
        const rows = await query(env, 'UPDATE products SET price = $1 WHERE id = $2 RETURNING id, name, price', [body.price, id]);
        return json(rows[0] || { error: 'Producto no encontrado' }, rows[0] ? 200 : 404);
      }

      // POST /api/orders — una ronda nueva enviada desde el tique del cliente
      if (path === '/api/orders' && request.method === 'POST') {
        const body = await request.json();
        const orderRows = await query(
          env,
          'INSERT INTO orders (table_number, round_number, total) VALUES ($1, $2, $3) RETURNING id, table_number, round_number, total, status, created_at',
          [body.table_number || null, body.round_number, body.total]
        );
        const order = orderRows[0];
        for (const item of body.items) {
          await query(
            env,
            'INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, note) VALUES ($1, $2, $3, $4, $5, $6)',
            [order.id, item.product_id || null, item.product_name, item.quantity, item.unit_price, item.note || '']
          );
        }
        return json(order, 201);
      }

      // GET /api/orders — para el panel de barra (todos, o filtrados por ?status=)
      if (path === '/api/orders' && request.method === 'GET') {
        const status = url.searchParams.get('status');
        const orders = status
          ? await query(env, 'SELECT * FROM orders WHERE status = $1 ORDER BY created_at DESC', [status])
          : await query(env, 'SELECT * FROM orders ORDER BY created_at DESC');
        for (const o of orders) {
          o.items = await query(env, 'SELECT product_name, quantity, unit_price, note FROM order_items WHERE order_id = $1', [o.id]);
        }
        return json(orders);
      }

      // PATCH /api/orders/:id — marcar un pedido como aceptado
      if (path.startsWith('/api/orders/') && request.method === 'PATCH') {
        const id = path.split('/').pop();
        const body = await request.json();
        const rows = await query(env, 'UPDATE orders SET status = $1 WHERE id = $2 RETURNING id, status', [body.status, id]);
        return json(rows[0] || { error: 'Pedido no encontrado' }, rows[0] ? 200 : 404);
      }

      return json({ error: 'Ruta no encontrada' }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
};
