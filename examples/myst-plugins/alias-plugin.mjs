import { u } from 'unist-builder';

export default {
  directives: [{
    name: 'demo:greeting',
    alias: ['demo:hello'],
    arg: { type: String, required: true },
    options: { suffix: { type: String, alias: ['ending'] } },
    body: { type: 'myst' },
    run(data) {
      return [
        u('paragraph', [u('strong', [u('text', `Hello, ${data.arg}${data.options.suffix ?? '!'}`)])]),
        ...data.body
      ];
    }
  }],
  roles: [{
    name: 'demo:badge',
    alias: ['demo:tag'],
    body: { type: String, required: true },
    run(data) {
      return [u('strong', [u('text', data.body)])];
    }
  }]
};
