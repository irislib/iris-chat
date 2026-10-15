import { expect,it } from 'vitest'
import { messageMarkdown } from './messageMarkdown'
import { formatMention } from './mentions'
it('renders canonical mentions with current local names, safe profile links and ordinary links',()=>{
 const key='a'.repeat(64)
 expect(messageMarkdown(formatMention(key,'Old'),{[key]:'New <script>'})).toContain(`href="#profile-${key}"`)
 expect(messageMarkdown(formatMention(key,'Old'),{[key]:'New <script>'})).toContain('@New &lt;script&gt;')
 expect(messageMarkdown('https://example.com')).toContain('href="https://example.com"')
 expect(messageMarkdown('[unsafe](javascript:alert)')).not.toContain('href=')
})
