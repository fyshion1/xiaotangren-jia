import unittest
from types import SimpleNamespace
from unittest.mock import patch

from app.services import intent_router as router
from app.services.embedding import EmbeddingError


class IntentRouterTests(unittest.TestCase):
    def setUp(self):
        router._cache.clear()
        router._retry_after.clear()
        self.settings = patch('app.config.get_settings', return_value=SimpleNamespace(
            runtime_profile='native', embed_local_model='test', embed_local_dir=''))
        self.compute = patch('app.services.compute.configuration', return_value=SimpleNamespace(mode='native'))
        self.settings.start()
        self.compute.start()
        self.addCleanup(self.settings.stop)
        self.addCleanup(self.compute.stop)

    def test_explicit_and_followup_never_load_model(self):
        with patch.object(router.embedding, 'embed_texts') as embed:
            for text in ('找到这首的歌词', '把资料放进知识库', '再读完那个版本', '继续刚才的'):
                self.assertTrue(router.classify(text).needs_tools)
            self.assertFalse(router.classify(' ').needs_tools)
            embed.assert_not_called()

    def test_chat_skips_tools_and_prototypes_cached_local_only(self):
        prototypes = [[1., 0.] if label == 'chat' else [0., 1.] for label in router._LABELS]
        with patch.object(router.embedding, 'embed_texts', side_effect=[prototypes, [[1., 0.]], [[1., 0.]]]) as embed:
            for _ in range(2):
                decision = router.classify('你好啊')
                self.assertFalse(decision.needs_tools)
                self.assertEqual(decision.method, 'local_embedding')
            self.assertEqual(embed.call_count, 3)
            for call in embed.call_args_list:
                self.assertEqual(call.kwargs['engine'], 'local')
                self.assertFalse(call.kwargs['_delegate'])

    def test_low_margin_and_mixed_input_consult_tools(self):
        prototypes = [[1., 0.] if label == 'chat' else [.99, .01] for label in router._LABELS]
        with patch.object(router.embedding, 'embed_texts', side_effect=[prototypes, [[1., 0.]]]):
            self.assertTrue(router.classify('拿不准的请求').needs_tools)
        # A later request must not be dropped after a casual opening.
        self.assertTrue(router.classify('你好' * 700 + '，半小时后叫我').needs_tools)

    def test_live_greeting_regression_and_mixed_reminder(self):
        # Live greeting scored .642 with .0806 margin: do not spend a model
        # turn continuing the previous song request. Mixed reminders stay routed.
        prototypes = [[.642, (1 - .642**2)**.5] if label == 'chat'
                      else [.5614, (1 - .5614**2)**.5] for label in router._LABELS]
        with patch.object(router.embedding, 'embed_texts', side_effect=[prototypes, [[1., 0.]]]):
            self.assertFalse(router.classify('小糖人晚上好呀，请用一句简短的话回应我。').needs_tools)
        router._cache.clear()
        prototypes = [[.704, (1 - .704**2)**.5] if label == 'chat'
                      else [.7028, (1 - .7028**2)**.5] for label in router._LABELS]
        with patch.object(router.embedding, 'embed_texts', side_effect=[prototypes, [[1., 0.]]]):
            self.assertTrue(router.classify('小糖人晚上好呀，过半小时记得叫我喝水').needs_tools)

    def test_missing_model_cooldown_no_repeated_load(self):
        with patch.object(router.embedding, 'embed_texts', side_effect=EmbeddingError('missing')) as embed:
            for _ in range(2):
                decision = router.classify('你好啊')
                self.assertTrue(decision.needs_tools)
                self.assertEqual(decision.method, 'local_unavailable')
            embed.assert_called_once()

    def test_lightweight_and_delegated_do_not_export_or_load(self):
        for profile, mode in [('lightweight', 'native'), ('native', 'delegated')]:
            with patch('app.config.get_settings', return_value=SimpleNamespace(runtime_profile=profile)), \
                 patch('app.services.compute.configuration', return_value=SimpleNamespace(mode=mode)), \
                 patch.object(router.embedding, 'embed_texts') as embed:
                self.assertTrue(router.classify('你好').needs_tools)
                embed.assert_not_called()
