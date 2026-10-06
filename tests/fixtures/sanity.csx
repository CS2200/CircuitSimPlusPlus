{
  "format": "circuitsim-plus-plus",
  "version": 2,
  "name": "sanity",
  "settings": {
    "delayModel": "delay",
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1"
  },
  "circuits": [
    {
      "name": "main",
      "components": [
        { "id": "clk", "type": "wiring.clock", "pos": [0, 0] },
        { "id": "one", "type": "wiring.constant", "pos": [0, 0], "attrs": { "value": "1" } },
        { "id": "zero", "type": "wiring.constant", "pos": [0, 0] },
        { "id": "r1", "type": "mem.register", "pos": [0, 0], "name": "r1" },
        { "id": "n1", "type": "gate.not", "pos": [0, 0] },
        { "id": "a1", "type": "gate.and", "pos": [0, 0] },
        { "id": "r2", "type": "mem.register", "pos": [0, 0], "name": "r2" },
        { "id": "p", "type": "wiring.probe", "pos": [0, 0], "name": "out" }
      ],
      "wires": [
        { "a": { "comp": "clk", "pin": "out" }, "b": { "comp": "r1", "pin": "clk" } },
        { "a": { "comp": "clk", "pin": "out" }, "b": { "comp": "r2", "pin": "clk" } },
        { "a": { "comp": "one", "pin": "out" }, "b": { "comp": "r1", "pin": "en" } },
        { "a": { "comp": "one", "pin": "out" }, "b": { "comp": "r2", "pin": "en" } },
        { "a": { "comp": "zero", "pin": "out" }, "b": { "comp": "r1", "pin": "rst" } },
        { "a": { "comp": "zero", "pin": "out" }, "b": { "comp": "r2", "pin": "rst" } },
        { "a": { "comp": "one", "pin": "out" }, "b": { "comp": "a1", "pin": "in1" } },
        { "a": { "comp": "r1", "pin": "q" }, "b": { "comp": "n1", "pin": "in" } },
        { "a": { "comp": "n1", "pin": "out" }, "b": { "comp": "r1", "pin": "d" } },
        { "a": { "comp": "n1", "pin": "out" }, "b": { "comp": "a1", "pin": "in0" } },
        { "a": { "comp": "a1", "pin": "out" }, "b": { "comp": "r2", "pin": "d" } },
        { "a": { "comp": "a1", "pin": "out" }, "b": { "comp": "p", "pin": "in" } }
      ]
    }
  ]
}
