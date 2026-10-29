import assert from "node:assert/strict";
import { redact } from "./redact.js";

assert.match(redact("key=" + "sk" + "-1234567890abcdefghijkl"), /\[REDACTED\]/);
assert.match(redact("Authorization: Bearer abc123-secret"), /Bearer \[REDACTED\]/);
assert.match(redact("postgres://alice:secret@db.example.test:5432/app"), /postgres:\/\/\[REDACTED\]@db\.example\.test:5432/);
const privateKeyLabel = ["PRIVATE", " KEY"].join("");
assert.match(redact(`-----BEGIN RSA ${privateKeyLabel}-----\nsecret\n-----END RSA ${privateKeyLabel}-----`), /REDACTED PRIVATE KEY/);
for (const value of ["deadbeefdeadbeefdeadbeef", "1d1d9178-c94a-45d9-a21d-eb4115732763", "ordinary words", "password is a word"]) assert.equal(redact(value), value);
console.log("redact tests passed");
