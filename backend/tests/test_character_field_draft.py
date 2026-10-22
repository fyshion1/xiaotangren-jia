import unittest
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException
from app.routers.characters import FieldDraftIn, draft_field


class CharacterFieldDraftTests(unittest.IsolatedAsyncioTestCase):
    async def generate(self, profile, provider):
        with patch('app.routers.nest._effective_config', return_value={
            'model': 'mock', 'base_url': 'http://mock.invalid/v1', 'api_key': 'secret'
        }), patch('app.providers.openai.complete_chat', provider):
            return await draft_field(FieldDraftIn(profile=profile, label='爱好'))

    async def test_images_are_excluded_and_draft_is_not_saved(self):
        provider = AsyncMock(return_value=' 烘焙，散步 ')
        with patch('app.db.upsert_character') as save:
            result = await self.generate({'name': '测试', 'portrait': 'data:image/png;base64,' + 'a' * 50000,
                                          'customFields': [{'label': '梦想', 'value': '开店'}]}, provider)
            save.assert_not_called()
        self.assertEqual(result, {'value': '烘焙，散步'})
        prompt = provider.call_args.args[0][1]['content']
        self.assertIn('梦想', prompt)
        self.assertNotIn('data:image', prompt)
        self.assertEqual(provider.call_args.kwargs['max_tokens'], 800)

    async def test_oversized_text_does_not_call_provider(self):
        provider = AsyncMock()
        with self.assertRaises(HTTPException) as error:
            await self.generate({'about': '文' * 9000}, provider)
        self.assertEqual(error.exception.status_code, 413)
        provider.assert_not_called()

    async def test_provider_error_is_sanitized(self):
        with self.assertRaises(HTTPException) as error:
            await self.generate({}, AsyncMock(side_effect=RuntimeError('private api key')))
        self.assertEqual(error.exception.status_code, 502)
        self.assertNotIn('private', error.exception.detail)

    async def test_empty_draft_is_rejected(self):
        with self.assertRaises(HTTPException) as error:
            await self.generate({}, AsyncMock(return_value='  '))
        self.assertEqual(error.exception.status_code, 502)
