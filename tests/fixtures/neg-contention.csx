{
  "format": "circuitsim-plus-plus",
  "version": 6,
  "name": "neg-contention",
  "settings": {
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1"
  },
  "circuits": [
    {
      "name": "main",
      "components": [
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
          "id": "controlled-buffer1",
          "type": "wiring.controlled-buffer",
          "pos": [
            0,
            0
          ]
        },
        {
          "id": "probe0",
          "type": "wiring.probe",
          "pos": [
            0,
            0
          ],
          "name": "bus"
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
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "controlled-buffer0",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "constant1",
            "pin": "out"
          },
          "b": {
            "comp": "controlled-buffer1",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "constant0",
            "pin": "out"
          },
          "b": {
            "comp": "controlled-buffer1",
            "pin": "en"
          }
        },
        {
          "a": {
            "comp": "controlled-buffer0",
            "pin": "out"
          },
          "b": {
            "comp": "probe0",
            "pin": "in"
          }
        },
        {
          "a": {
            "comp": "controlled-buffer1",
            "pin": "out"
          },
          "b": {
            "comp": "probe0",
            "pin": "in"
          }
        }
      ]
    }
  ]
}
