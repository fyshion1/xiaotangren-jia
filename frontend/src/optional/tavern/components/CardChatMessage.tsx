// Optional feature contract and unavailable fallback; contains no feature implementation.
import type { CharacterProfile } from '../../../data/characters';
/** Rendering is a view over stored text; the iframe cannot access the host. */
export default function CardChatMessage({ text, character, mode, depth, streaming }: {
    text: string;
    character?: CharacterProfile;
    mode: 'chat' | 'html';
    depth: number;
    streaming: boolean;
}): import("react").JSX.Element;
export default function CardChatMessage(..._args: unknown[]): import('react').JSX.Element { return null as unknown as import('react').JSX.Element }
