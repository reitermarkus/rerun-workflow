// FIXME: https://github.com/dotansimha/graphql-code-generator-community/issues/225
// FIXME: https://github.com/TypeStrong/ts-node/issues/1909#issuecomment-2089155346

import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('ts-node/esm', pathToFileURL('./'))
