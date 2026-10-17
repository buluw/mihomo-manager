import assert from "node:assert/strict"
import test from "node:test"
import { parseAllDocuments } from "yaml"
import { formatYaml } from "../src/components/patterns/monacoYaml.ts"

test("YAML formatting expands an inline proxy into ordered block fields", () => {
  const content = "proxies:\n  - { name: sample, server: example.invalid, port: 443, type: socks5, udp: true }\n"
  const result = formatYaml(content)
  assert.equal(result.issue, undefined)
  assert.equal(result.text, "proxies:\n  - name: sample\n    server: example.invalid\n    port: 443\n    type: socks5\n    udp: true\n")
  assert.deepEqual(parseAllDocuments(result.text)[0]!.toJS(), parseAllDocuments(content)[0]!.toJS())
  assert.equal(formatYaml(result.text).text, result.text)
})

test("YAML formatting expands nested objects and arrays using the requested indentation", () => {
  const content = "proxy: {name: sample, dialer: {addresses: [example.invalid, backup.invalid], options: {udp: true, timeout: 3}}, ports: [443,8443]}\n"
  const result = formatYaml(content, 4)
  assert.equal(result.issue, undefined)
  assert.equal(result.text, "proxy:\n    name: sample\n    dialer:\n        addresses:\n            - example.invalid\n            - backup.invalid\n        options:\n            udp: true\n            timeout: 3\n    ports:\n        - 443\n        - 8443\n")
  assert.deepEqual(parseAllDocuments(result.text)[0]!.toJS(), parseAllDocuments(content)[0]!.toJS())
  assert.equal(formatYaml(result.text, 4).text, result.text)
})

test("YAML formatting preserves comments, anchors, values and document boundaries", () => {
  const content = "# heading\nbase: &base {name: 'sample', enabled: true} # inline\ncopy: *base\nnumber: 9007199254740993\nitems: [one,two,three]\ntext: |+\n  first line\n  second line\n\n---\n# another document\nmap: {nested: [1,2]}\n"
  const result = formatYaml(content)
  assert.equal(result.issue, undefined)
  assert.notEqual(result.text, content)
  const values = (text: string) => parseAllDocuments(text, { intAsBigInt: true }).map(document => document.toJS())
  assert.deepEqual(values(result.text), values(content))
  for (const comment of ["# heading", "# inline", "# another document"]) assert.ok(result.text.includes(comment))
  assert.match(result.text, /&base/)
  assert.match(result.text, /\*base/)
  assert.equal(formatYaml(result.text).text, result.text)
})

test("invalid YAML and unresolved aliases keep their complete source text", () => {
  for (const content of ["a: [1,2\n", "a: 1\na: 2\n", "a: *missing\n"]) {
    const result = formatYaml(content)
    assert.equal(result.text, content)
    assert.ok(result.issue?.message)
  }
})

test("YAML formatting uses the requested indentation and preserves scalar types", () => {
  const content = 'object:\n    enabled: false\n    empty: null\n    code: "001"\n    items: ["true",1.25]\n'
  const result = formatYaml(content, 2)
  assert.equal(result.issue, undefined)
  assert.match(result.text, /\n  enabled: false/)
  assert.deepEqual(parseAllDocuments(result.text)[0]!.toJS(), parseAllDocuments(content)[0]!.toJS())
  assert.equal(formatYaml("# comment only\n").text, "# comment only\n")
})
