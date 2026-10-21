{
  "format": "circuitsim-plus-plus",
  "version": 5,
  "name": "neg-floating-read",
  "settings": {
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1"
  },
  "circuits": [
    {
      "name": "main",
      "components": [
        {
          "id": "clk",
          "type": "wiring.clock",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "constant0",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "1"
          }
        },
        {
          "id": "constant1",
          "type": "wiring.constant",
          "pos": [
            0,
            0
          ],
          "attrs": {
            "value": "0"
          }
        },
        {
          "id": "controlled-buffer0",
          "type": "wiring.controlled-buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "register0",
          "type": "mem.register",
          "pos": [
            0,
            0
          ],
          "name": "r",
          "attrs": {
            "showClk": true
          }
        }
      ],
      "wires": [
        {
          "a": {
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "controlled-buffer0",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "constant1",
            "pin": "out"
          },
          "b": {
            "comp": "controlled-buffer0",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "clk",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "clk"
          }
        },
        {
          "a": {
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "controlled-buffer0",
            "pin": "out"
          },
          "b": {
            "comp": "register0",
            "pin": "d"
          }
        }
      ]
    }
  ]
}
