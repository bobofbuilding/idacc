export async function handleControllerRoutes({
  method,
  path,
  searchParams,
  req,
  res,
  readBody,
  send,
  getController,
  listControllers,
  upsertController,
  linkControllerAgent,
  controllerScopeUserId,
} = {}) {
  if (method === 'GET' && path === '/controllers') {
    const controllers = listControllers({
      type: searchParams.get('type') ?? '',
      q: searchParams.get('q') ?? '',
      agentId: searchParams.get('agent_id') ?? searchParams.get('agentId') ?? '',
      status: searchParams.get('status') ?? 'active',
      limit: Number(searchParams.get('limit') ?? 50),
    });
    send(res, 200, { ok: true, controllers });
    return true;
  }

  if (method === 'POST' && path === '/controllers') {
    const body = await readBody(req);
    const controller = upsertController(body);
    send(res, 200, {
      ok: true,
      controller,
      scope_user_id: controllerScopeUserId(controller.controller_id),
    });
    return true;
  }

  const linkMatch = path.match(/^\/controllers\/(.+)\/agent-links$/);
  if (method === 'POST' && linkMatch) {
    const body = await readBody(req);
    const controllerId = decodeURIComponent(linkMatch[1]);
    const link = linkControllerAgent({
      ...body,
      controller_id: controllerId,
    });
    send(res, 200, { ok: true, link, controller: getController(controllerId) });
    return true;
  }

  const oneMatch = path.match(/^\/controllers\/(.+)$/);
  if (method === 'GET' && oneMatch) {
    const controllerId = decodeURIComponent(oneMatch[1]);
    const controller = getController(controllerId);
    if (!controller) {
      send(res, 404, { ok: false, error: 'controller not found' });
      return true;
    }
    send(res, 200, { ok: true, controller });
    return true;
  }

  return false;
}
