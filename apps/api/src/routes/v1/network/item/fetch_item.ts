import z, {
  FetchItemsBodySchema,
  FetchItemsCountBodySchema,
  FetchItemsQuerySchema,
  ItemResponseSchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import {
  countLocalItems,
  fetchLocalItems,
} from '@/utils/item_fetch_runtime';
import { getNetworkConfigById } from '@/network_configs';
import { fetchItemsAcrossInstances } from '@/utils/inter_instance_fetch';
import { peer_instance_guard } from '@/middleware/peer_instance_guard';
import { public_rate_limit } from '@/middleware/public_rate_limit';

type FetchItemsAggregateRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchItemsQuerySchema>;
}>;

type FetchItemsLocalRequest = FastifyRequest<{
  Body: z.infer<typeof FetchItemsBodySchema>;
}>;

export const fetch_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/item/fetch',
    method: 'GET',
    // Unauthenticated by design (public network browse). Each call can fan out
    // to every peer instance in the network config, so an unthrottled caller
    // amplifies load across the whole network, not just this host.
    preHandler: public_rate_limit('network_item_fetch', 100),
    schema: {
      tags: ['network'],
      query: FetchItemsQuerySchema,
      response: {
        200: z.object({
          meta: z.object({
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
            partial: z.boolean(),
            unavailable_instances: z.string().array(),
          }),
          items: ItemResponseSchema.array(),
        }),
      },
    },
    handler: fetch_network_item_handler,
  });

  fastify.route({
    url: '/item/count_local',
    method: 'POST',
    preHandler: peer_instance_guard,
    schema: {
      tags: ['network'],
      body: FetchItemsCountBodySchema,
      response: {
        200: z.object({
          count: z.number(),
        }),
      },
    },
    handler: count_local_items_handler,
  });

  fastify.route({
    url: '/item/fetch_local',
    method: 'POST',
    preHandler: peer_instance_guard,
    schema: {
      tags: ['network'],
      body: FetchItemsBodySchema,
      response: {
        200: z.object({
          meta: z.object({
            total: z.number(),
            limit: z.number(),
            offset: z.number(),
          }),
          items: ItemResponseSchema.array(),
        }),
      },
    },
    handler: fetch_local_items_handler,
  });
};

const fetch_network_item_handler = async (
  request: FetchItemsAggregateRequest,
  reply: FastifyReply
) => {
  const {
    item_id,
    item_network,
    item_type,
    item_domain,
    item_instance_url,
    item_schema_url,
    item_state,
    item_latitude,
    item_longitude,
    radius_meters,
    limit,
    offset,
    cache_ttl_seconds,
  } = request.query;

  try {
    const networkConfig = await getNetworkConfigById(item_network);
    const domainExists = networkConfig.domains.some(
      (domain: (typeof networkConfig.domains)[number]) =>
        domain.id === item_domain
    );

    if (!domainExists) {
      return await replyForUnservedDomain(reply, item_network, item_domain);
    }

    const result = await fetchItemsAcrossInstances({
      networkConfig,
      filters: {
        item_id,
        item_network,
        item_type,
        item_domain,
        item_instance_url,
        item_schema_url,
        item_state,
        item_latitude,
        item_longitude,
        radius_meters,
        limit,
        offset,
        lifecycle_filter: 'live_only',
      },
      requestedCacheTtlSeconds: cache_ttl_seconds,
      log: request.log,
    });

    reply.header('x-network-partial', String(result.meta.partial));
    return reply.code(200).send(result);
  } catch (err) {
    request.log.error(
      { err, query: request.query },
      'Failed to fetch items across network instances'
    );

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch items across network instances',
    });
  }
};

const count_local_items_handler = async (
  request: FetchItemsLocalRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  const count = await countLocalItems({ ...body, lifecycle_filter: 'live_only' });
  return reply.code(200).send({ count });
};

const fetch_local_items_handler = async (
  request: FetchItemsLocalRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  return reply.code(200).send(await fetchLocalItems({ ...body, lifecycle_filter: 'live_only' }));
};
