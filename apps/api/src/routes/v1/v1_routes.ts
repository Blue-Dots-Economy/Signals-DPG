import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import item_routes from '@/routes/v1/item/item_routes';
import action_routes from '@/routes/v1/action/action_routes';
import event_routes from '@/routes/v1/event/event_routes';
import network_routes from '@/routes/v1/network/network_routes';
import match_score_routes from '@/routes/v1/match_score/match_score_routes';
import admin_routes from '@/routes/v1/admin/admin_routes';
import aggregator_routes from '@/routes/v1/aggregator/aggregator_routes';
import consent_routes from '@/routes/v1/consent/consent_routes';
import { auth_config } from '@/routes/v1/auth/auth_config';
import { auth_me } from '@/routes/v1/auth/me';
import { auth_session } from '@/routes/v1/auth/session';
import { auth_signup } from '@/routes/v1/auth/signup';
import { u18_precheck } from '@/routes/v1/auth/u18_precheck';
import { user_domains } from '@/routes/v1/user/user_domains';
import { submit_support } from '@/routes/v1/support/submit_support';
import { support_config } from '@/routes/v1/support/support_config';

const v1_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.register(item_routes, { prefix: '/item' });
  fastify.register(action_routes, { prefix: '/action' });
  fastify.register(event_routes, { prefix: '/event' });
  fastify.register(match_score_routes, { prefix: '/match-score' });
  fastify.register(network_routes, { prefix: '/network' });
  fastify.register(admin_routes, { prefix: '/admin' });
  fastify.register(aggregator_routes, { prefix: '/aggregator' });
  fastify.register(consent_routes, { prefix: '/consent' });
  fastify.register(auth_config, { prefix: '/auth' });
  fastify.register(auth_me, { prefix: '/auth' });
  fastify.register(auth_session, { prefix: '/auth' });
  fastify.register(auth_signup, { prefix: '/auth' });
  fastify.register(u18_precheck, { prefix: '/auth' });
  fastify.register(user_domains, { prefix: '/user' });
  fastify.register(submit_support, { prefix: '/support' });
  fastify.register(support_config, { prefix: '/support' });
};

export default v1_routes;
