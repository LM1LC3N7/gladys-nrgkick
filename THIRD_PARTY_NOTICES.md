# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## nrgkick-api

Its NRGkick client (`src/nrgkick/client.js`, the endpoints, query
parameters, codes and limits of `src/constants.js`) is a JavaScript port of
parts of **nrgkick-api** 1.8.1 (<https://github.com/andijakl/nrgkick-api>),
the Python library of Home Assistant's NRGkick integration: the endpoints
`/info`, `/values` and `/control`, the raw mode, the optional HTTP Basic auth,
the message of a JSON API turned off, the commands written through the query
string of `/control` and the check of their answer, and the enums of the
charging status, the warning, error and connector codes. No Python code runs
here and nrgkick-api is not a dependency. Its license:

```
MIT License

Copyright (c) 2024 Andreas Jakl

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The test fixtures (`test/fixtures/fakeNrgkick.js`) are shaped like the
examples of the NRGkick Gen2 local API documentation shipped with
nrgkick-api; their values are made up.

## Sibling integrations (same project, Apache-2.0)

- The energy index guard (`src/guard.js`, `test/guard.test.js`) is taken as
  it is from gladys-p1-monitor (<https://github.com/LM1LC3N7/gladys-p1-monitor>),
  with the limits as a parameter as in gladys-imeon.
- The transport (`src/nrgkick/http.js`), the publisher and the command rules
  follow gladys-peblar (<https://github.com/LM1LC3N7/gladys-peblar>).

NRGkick is a trademark of DiniTech GmbH. This project is not affiliated with,
endorsed by or supported by DiniTech.
