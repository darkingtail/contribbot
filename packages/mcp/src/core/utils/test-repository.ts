import { fixtureProjectDirectory, fixtureRepository } from '../execution/__fixtures__/repository.js'

export const testRepository = fixtureRepository('owner/repo')

export function testProjectDirectory(dataRoot?: string): string {
  return fixtureProjectDirectory(dataRoot, testRepository.path)
}
