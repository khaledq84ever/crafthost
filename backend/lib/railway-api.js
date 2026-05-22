// Railway GraphQL client — provisions per-server TCP proxy ports.
// Each MC server gets its own kodama.proxy.rlwy.net:<port> address by calling
// tcpProxyCreate. Requires the operator to set RAILWAY_API_TOKEN on the service
// (https://railway.com/account/tokens → "Create token" → add as variable).
//
// Service/environment/project IDs are auto-injected by Railway as env vars on
// every deployment, so no extra setup is needed.

const ENDPOINT = process.env.RAILWAY_GRAPHQL || 'https://backboard.railway.com/graphql/v2';

function isConfigured() {
  return !!(process.env.RAILWAY_API_TOKEN && process.env.RAILWAY_ENVIRONMENT_ID && process.env.RAILWAY_SERVICE_ID);
}

async function gql(query, variables) {
  if (!process.env.RAILWAY_API_TOKEN) throw new Error('RAILWAY_API_TOKEN not set');
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.RAILWAY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await r.json();
  if (data.errors) {
    const msg = data.errors.map(e => e.message).join('; ');
    throw new Error('Railway API: ' + msg);
  }
  return data.data;
}

// Provision a new TCP proxy port forwarding to the given internal port on our
// service. Returns { id, domain, proxyPort, applicationPort }.
async function createTcpProxy(applicationPort) {
  const d = await gql(`
    mutation tcpProxyCreate($input: TCPProxyCreateInput!) {
      tcpProxyCreate(input: $input) {
        id
        applicationPort
        proxyPort
        domain
      }
    }
  `, {
    input: {
      applicationPort,
      environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
      serviceId: process.env.RAILWAY_SERVICE_ID,
    },
  });
  return d.tcpProxyCreate;
}

async function deleteTcpProxy(id) {
  await gql(`mutation tcpProxyDelete($id: String!) { tcpProxyDelete(id: $id) }`, { id });
}

async function listTcpProxies() {
  const d = await gql(`
    query tcpProxies($serviceId: String!, $environmentId: String!) {
      tcpProxies(serviceId: $serviceId, environmentId: $environmentId) {
        id applicationPort proxyPort domain
      }
    }
  `, {
    serviceId: process.env.RAILWAY_SERVICE_ID,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID,
  });
  return d.tcpProxies || [];
}

module.exports = { isConfigured, createTcpProxy, deleteTcpProxy, listTcpProxies };
