/**
 * System-prompt section for the OneBot channel: platform constraints the
 * model must follow while chatting via QQ. The dsh equivalent of the Hermes
 * platform_hint.
 * @module dsh-onebot/prompt
 */
/**
 * Build the platform-guidance section text.
 * @param restrictedMembers - whether restricted-member mode is active.
 * @param persona - optional role/persona text configured by the operator (T11);
 *   empty/absent = no persona layer, behavior identical to 0.9.4.
 * @returns the section text.
 */
export declare function buildPlatformPrompt(restrictedMembers: boolean, persona?: string): string;
