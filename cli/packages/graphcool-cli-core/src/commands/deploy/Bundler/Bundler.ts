import Deploy from '../index'
import {ProjectDefinitionClass, ExternalFiles, ExternalFile, Config, Client, Output} from 'graphcool-cli-engine'
import * as archiver from 'archiver'
import * as fs from 'fs-extra'
import * as path from 'path'
import * as multimatch from 'multimatch'
import {FunctionDefinition} from 'graphcool-json-schema'
import TypescriptBuilder from './TypescriptBuilder'
import * as FormData from 'form-data'
const debug = require('debug')('bundler')
import * as fetch from 'node-fetch'

const patterns = [
  '**/*.graphql',
  '**/graphcool.yml'
].map(i => `!${i}`)
patterns.unshift('**/*')

export interface FunctionTuple {name: string, fn: FunctionDefinition}

export default class Bundler {
  definition: ProjectDefinitionClass
  config: Config
  client: Client
  out: Output
  projectId: string
  buildDir: string
  zipPath: string
  constructor(cmd: Deploy, projectId: string) {
    this.out = cmd.out
    this.definition = cmd.definition
    this.config = cmd.config
    this.client = cmd.client
    this.projectId = projectId
    this.buildDir = path.join(this.config.definitionDir, '.build/')
    this.zipPath = path.join(this.config.definitionDir, 'build.zip')
  }

  async bundle(): Promise<ExternalFiles> {
    if (this.functions.length === 0) {
      return {}
    }

    debug('bundling')
    // clean build dir & create it
    fs.removeSync(this.buildDir)
    fs.mkdirpSync(this.buildDir)
    debug('emptied .build')
    // await this.cpFiles(this.config.definitionDir, this.buildDir)
    debug('copied files')
    const builder = new TypescriptBuilder(this.config.definitionDir, this.buildDir)
    const zip = this.zip()
    await builder.compile(this.fileNames)
    zip.directory(this.buildDir, false)
    zip.finalize()
    debug('compiled typescript')
    this.generateEnvFiles()
    debug('generated env files')
    this.generateHandlerFiles()
    debug('zipped2')

    const url = await this.upload(zip)
    debug('uploaded', url)

    return this.getExternalFiles(url)
  }

  cleanBuild(): Promise<void> {
    return fs.remove(this.buildDir)
  }

  zip(): any {
    const zip = archiver('zip')
    zip.on('error', (err) => {
      this.out.error('Error while zipping build: ' + err)
    })
    zip.directory(this.config.definitionDir, false)
    return zip
  }

  async upload(stream: any): Promise<string> {
    const url = await this.client.getDeployUrl(this.projectId)
    const form = new FormData()
    form.append('file', stream)

    debug(`submitting file to ${url}`)

    await fetch(url, { method: 'PUT', body: form })
    debug('uploaded')

    return url
  }

  getExternalFiles(url: string): ExternalFiles {
    return this.functions.reduce((acc, fn) => {
      const src = fn.fn.handler.code!.src
      const buildFileName = this.getBuildFileName(src)
      const lambdaHandler = this.getLambdaHandler(buildFileName)
      const devHandler = this.getDevHandlerPath(buildFileName)

      const externalFile = {
        url,
        lambdaHandler,
        devHandler,
      }
      return {...acc, [src]: externalFile}
    }, {})
  }

  generateEnvFiles() {
    this.functions.forEach(fn => {
      const src = fn.fn.handler.code!.src
      const buildFileName = this.getBuildFileName(src)
      const envPath = path.join(this.buildDir, this.getEnvPath(buildFileName))
      if (fn.fn.handler.code!.environment) {
        const env = JSON.stringify(fn.fn.handler.code!.environment)
        fs.writeFileSync(envPath, env)
      }
    })
  }

  generateHandlerFiles() {
    this.functions.forEach(fn => {
      const src = fn.fn.handler.code!.src
      const buildFileName = path.join(this.buildDir, this.getBuildFileName(src))
      const lambdaHandlerPath = this.getLambdaHandlerPath(buildFileName)
      const devHandlerPath = this.getDevHandlerPath(buildFileName)
      const bylinePath = this.getBylinePath(buildFileName)
      fs.copySync(path.join(__dirname, './proxies/lambda.js'), lambdaHandlerPath)
      fs.copySync(path.join(__dirname, './proxies/dev.js'), devHandlerPath)
      fs.copySync(path.join(__dirname, './proxies/byline.js'), bylinePath)
    })
  }

  async cpFiles(src: string, dest: string) {
    await fs.copy(src, dest, {
      filter: this.validFile
    })
  }

  validFile(filePath: string) {
    return multimatch(filePath, patterns).length > 0
  }

  get functions(): Array<FunctionTuple> {
    const functions = this.definition.definition!.modules[0].definition!.functions

    if (!functions) {
      return []
    } else {
      return Object.keys(functions)
        .filter(name => functions[name].handler.code)
        .map(name => {
          return {
            name,
            fn: functions[name]
          }
        })
    }
  }

  get fileNames(): string[] {
    return this.functions.map(fn => path.join(this.config.definitionDir, fn.fn.handler.code!.src))
  }

  getBuildFileName = (src: string) => path.join(src.replace(/\.ts$/, '.js'))
  getLambdaHandlerPath = (fileName: string) => fileName.slice(0, fileName.length - 3) + '-lambda.js'
  getLambdaHandler = (fileName: string) => fileName.slice(0, fileName.length - 3) + '-lambda.handle'
  getDevHandlerPath = (fileName: string) => fileName.slice(0, fileName.length - 3) + '-dev.js'
  getBylinePath = (fileName: string) => path.dirname(fileName) + '/byline.js'
  getEnvPath = (fileName: string) => fileName.slice(0, fileName.length - 3) + '.env.json'

}